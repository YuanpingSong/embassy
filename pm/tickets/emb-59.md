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

## Live proof result and ruling (2026-08-16)

**Live proof: the fail-safe boundary held.** Pin gpt-5.6-luna/minimal did not resolve against the
live catalog; the probe declined BEFORE thread creation — archivedThreadCount 0, measured token
count 0, safe code CODEX_WRITE_PROBE_MODEL_PIN_UNAVAILABLE, all four read probes passing. Offline
schema recheck confirms the parser matches generated 0.147.0 exactly; the pin was not weakened.

**Ruling**: (1) This IS an acceptable live-proof outcome for the fail-safe half of the promise set —
the founder's cost requirement demonstrated live is evidence, not absence of it. (2) ONE bounded
catalog-shape diagnostic AUTHORIZED (model/list read only; no turn, no creation, no second live
write attempt): report whether gpt-5.6-luna is absent, hidden, or lacks minimal support, and name
the cheapest visible model supporting minimal. (3) The pin is FOUNDER-NAMED: any revision is the
founder's call, queued with the diagnostic data. (4) emb-60 stays gated on a live PASSING probe —
unchanged. SLICE READY proceeds after the diagnostic; the fork trial runs on the frozen diff
regardless (taste review needs no live pin).

## Catalog diagnostic result + rebase ruling (2026-08-16)

**Diagnostic (one model/list read, nothing spawned)**: gpt-5.6-luna present, not hidden, lacks
`minimal`; NO visible model advertises minimal (8 models, no more pages); no price evidence exists.
**FOUNDER DECISION QUEUED**: the pin's effort half cannot be satisfied as named. PM recommendation:
redefine CODEX_PROBE_EFFORT as "the lowest effort the pinned model actually advertises" (canonical
enum order none<minimal<low<medium<...), keeping the founder's lowest-spend intent without a new
founder decision per Codex release; verified via model/rerouted + settings echo as designed.
Alternative: retain zero-spend fail-safe until minimal ships. Implementation pin unchanged pending
the founder's word.

**Rebase ruling**: rebase in the lane and repeat the authoritative pair on the new tip — the
emb-55 landing touches runAutomaticCompatibilityProbesLocked, the same function this slice changes;
that seam is the author's to resolve, not the PM cherry-pick's. The 808/808 + soak on 3d574ce stand
as pre-rebase evidence; the handoff claim is "this diff, on this base, passes."

**Reviews launched in parallel on the frozen 9ad0398 diff** (fork trial: taste half; fresh opus:
adversarial half); any rebase-delta gets a bounded re-look at landing.

---

## Taste review (2026-08-16, briefed-variant fork trial)

# TASTE REVIEW — emb-59 frozen diff (base 3d574ce)

## 1. APPETITE — did it buy exactly the promise set?

**Verdict: yes on the promise set; one item bought beyond it, one bought thinner than stated.**

Every clause of the Binding's promise list maps to shipped code, and the six isolation assertions are each machine-checked *and* individually tested:

| Promise (emb-59 Binding / emb-49 §1) | Where | Test |
|---|---|---|
| 1 fresh identity | `probeCleanupThreadId` (UUIDv7 grammar, not in pre-snapshot, ≠ route thread, ∉ forbidden set) | "rejects reused identities…", providers "rejects retained and sentinel thread identities" |
| 2 owned empty 0700 cwd | `attestCodexWriteProbeDirectory` (providers) + inline stat/readdir gate (connector) | providers "uses one owned 0700 cwd…" asserts `probeCwdMode === 0o700` and parent === state root |
| 3 fence declared | `thread/start` params asserted byte-exact in test (`sandbox: "read-only"`, `approvalPolicy: "never"`, empty `dynamicTools`/`environments`/`runtimeWorkspaceRoots`/`selectedCapabilityRoots`, `allowProviderModelFallback:false`) | "pins policy, tolerates response races…" |
| 4 fence observed | `PROBE_TOOL_NOTIFICATION_METHODS` + **item-type allowlist** (`agentMessage`/`reasoning`/`userMessage`, anything else fails) + probe-correlated `handleServerRequest` → `TOOL_ACTIVITY_OBSERVED` | "targeted probe activity and out-of-order lifecycle frames fail before archival" |
| 5 cwd unchanged | dev/ino/mode/mtimeNs/uid compare, both sides of the seam | "rejects a cwd mutation despite an otherwise clean turn" |
| 6 cleanup confirmed | archive → unsubscribe → re-list, failure ⇒ `CLEANUP_UNCONFIRMED` which **dominates** every earlier code | "cleanup uncertainty dominates earlier probe failures" |

Verified model pin is real, not requested-and-hoped: resolve via `model/list` (present ∧ `hidden===false` ∧ advertises `minimal`), pin at thread level *and* turn level, `allowProviderModelFallback:false`, `model/rerouted` ⇒ `MODEL_REROUTED`, plus a `thread/settings/updated` echo check. That is the emb-49 §6 design executed exactly.

Zero authority is proven, not asserted: `test/gateway-service.test.ts` "passing write evidence is derived and persisted without unlocking schema-attested Codex" — tier stays `schema_attested`, `writesCovered` flips true, and no route unlocks. The diffstat corroborates: **no dashboard, no copy, no docs, no types.ts, no compatibility.ts** in the six touched files. Nothing was bought that the ticket didn't order — with two exceptions:

- **Bought beyond the order:** the controller **state-root** attestation (`attestCodexWriteProbeStateRoot` + `sameCodexWriteProbeStateRoot`, ~55 source lines) runs *before and after* the probe and **throws `BridgeError("CODEX_FACTORY_ATTESTATION_INVALID")`**, which `runCompatibilityProbesFor` then explicitly re-throws. The pre-check earns its place (mkdtemp into a swapped root would void assertion 2). The post-check plus the fatal escalation does not: the promise set says *"never-throw discipline (boot catch at service.ts:966 kills the whole broker)"*, and emb-49 §4 wrote the acceptance criterion verbatim — *"preserve the single generation carve-out, **add nothing else that throws**."* This diff adds a second throw. See PM item 1.
- **Bought thinner than stated:** the `thread/settings/updated` echo is validated **only if it arrives**; nothing requires it. "Pin requested is not pin honored" is therefore carried by `model/rerouted` alone. Defensible, but it is a weaker verification than the words imply.

## 2. BUDGET HONESTY — 1,041 source lines against ≤1,050

**Verdict: honest, and unusually so. No disguised overage, no padded underage.**

```
src/gateway/codex-app-server.ts   +670  -2
src/gateway/providers.ts          +321  -3
src/gateway/service.ts             +50  -2
                          source  +1041 -7   (net +1034)
test/*                            +1342 -15
                           total  +2383
```

1,041 added source lines against the revised **≤1,050 post-diet** target (Budget contest ruling 1) — 9 lines of headroom, or 16 on a net basis. That margin is close enough to demand a golfing check; the code fails the golfing test in the *right* direction:

- Only **9 of 1,041** added source lines exceed 80 chars (0.86%), against a base-file rate of 0.7% in `providers.ts` — and 3 of the 9 are long message strings, which the base does too. No systematic compression.
- Several declarations are wrapped *more* than necessary — `type ProbePhase` across 5 lines, `private compatibilityProbeContext:` across 3, the `latestWriteCompatibilityProbeObservation` return type across 3. A budget-gamer collapses those and buys back ~15 lines. Nobody did.
- Nothing production leaked into tests: the test additions are an App-Server fake (`probeScenarioHandler`, `emitSuccessfulProbeTurn`, `probeThreadStartResult`) and table-driven fixtures — harness, not hidden implementation.
- Tests:source = **1.29:1**, against the repo's 1.05:1 baseline and emb-49's own prediction ("comparable or larger"). Appropriate for `coverage + adversarial fixtures`; not padded — 13 named cases, most table-driven over 4–7 fixtures each, and I found no duplicate-coverage filler.

The estimation lesson recorded in the budget ruling is confirmed: design-time ~520 → ground-truth 1,041, exactly 2×.

One accounting note the record leaves open: "≤1,050 source lines" is not defined as added-lines / net-lines / final-file-lines. All three readings pass here (1,041 / 1,034 / same), so the ambiguity cost nothing — this time.

## 3. SIMPLICITY by the record's standards

**Verdict: passes. Value judgments are in reviewed constants; no new user-facing concept; no speculative machinery except the one item above.**

Value judgments, all greppable source constants as emb-49 §6 demanded ("Embassy's design consistently puts value judgments in reviewed constants"): `CODEX_PROBE_MODEL_PREFERENCE`, `CODEX_PROBE_EFFORT`, `CODEX_WRITE_PROBE_INPUT` (fixed, never templated — §2), `MAX_CODEX_WRITE_PROBE_ATTEMPTS = 16` (mirrors `COMPATIBILITY_ATTESTATION_CAPACITY = 16` at `store.ts:110`, exactly as Ruling 2/contest #11 required), `PROBE_PASSIVE_ITEM_TYPES`, `PROBE_TOOL_NOTIFICATION_METHODS`, `PROBE_ONLY_METHODS`.

User-facing concepts added: **zero**. No column, no tier, no persisted field, no journal action (correctly deferred to emb-60 per the analysis-phase ruling), no copy string. The only new user-visible artifacts are 7 runtime alert codes, which the Binding names as part of the promise ("failures are safe codes + alerts, never failed probes") and Ruling 2 explicitly authorized the 7th.

Restraint I want to credit, because it is the tasteful move and it cost lines to make: `PROBE_ONLY_METHODS` means the four new allowlist entries are **rejected on every ordinary connector** — the widened allowlist grants nothing to the route path. The pre-existing negative test was widened rather than deleted (`thread/list` case preserved, four new methods added), which satisfies §5's deleted-test rule by making the deletion a strict superset. Likewise `item/started` is un-opted-out **only** for the probe connector, exactly as the fence-correction ruling specified.

Smells, none disqualifying:

- **Assertions 2 and 5 are implemented twice**, in two modules, by two independently written predicates (`attestCodexWriteProbeDirectory` in `/Users/yuanpingsong/Desktop/repos/embassy/src/gateway/providers.ts` and the inline `stat`/`readdir` block in `runWriteCompatibilityProbe`). Four stat+readdir round-trips of one empty directory. Defensible as a trust seam (the connector shouldn't trust a caller-supplied path it hands to the App Server, and the file's existing style validates its own inputs) — but it is ~35 duplicated source lines inside a budget that finished 9 lines from its cap.
- **`GatewayCompatibilityProbeContext.forbiddenCodexThreadIds`** puts a Codex-shaped field on the deliberately narrow generic provider boundary, and the context is handed to the Claude adapter too. Cheapest correct thing; still an altitude wobble on an interface whose doc comment advertises its narrowness.
- Two of the eight `PROBE_TOOL_NOTIFICATION_METHODS` (`item/commandExecution/outputDelta`, `turn/diff/updated`) are methods the probe connector still opts *out* of. Harmless belt-and-braces; the fence actually holds via the `item/started` item-type allowlist, which is the fail-closed form and the better design.
- `MAX_PROBE_TOKEN_COUNT = 1_000_000_000`, `model/list limit: 100`, loaded-list cap `100_000`: arbitrary bounds, unreviewed by the record, consistent with house style.

Nothing under-built against a promise, with the two Appetite caveats.

## 4. INTENDED-BEHAVIOR CLASSIFICATION — what a fresh bug-hunter will flag that the record already settled

Ordered by how loudly I expect it to be reported:

1. **"The shipped pin can never resolve — `CODEX_PROBE_EFFORT = "minimal"` matches no model in the live catalog, so this feature is dead code."** INTENDED. Catalog diagnostic ruling (2026-08-16): *"gpt-5.6-luna present, not hidden, lacks `minimal`; NO visible model advertises minimal… **Implementation pin unchanged pending the founder's word**"* and *"The pin is FOUNDER-NAMED: any revision is the founder's call."* Shipping a provably-declining pin is the ruled state, not an oversight.
2. **"Live proof never exercised the passing path."** INTENDED. Live-proof ruling: *"This IS an acceptable live-proof outcome for the fail-safe half of the promise set — the founder's cost requirement demonstrated live is evidence, not absence of it"*, with emb-60 still gated on a live *passing* probe.
3. **"Multiple archived probe threads can accumulate in the user's Codex — the founder said one per version."** INTENDED. Cardinality ruling: the founder sentence *"approves the artifact class, not a lifetime cardinality guarantee"*; the shipped bound is one attempt per (version, endpointGeneration) per broker process, flagged for morning ratification.
4. **"The 17th distinct (version, generation) tuple fails without ever being retried, and the cap never evicts — that's a leak/DoS."** INTENDED. Budget-contest Ruling 2: *"NEVER evict (eviction would permit a duplicate probe — the one-shot property is load-bearing); the 17th distinct tuple returns a frozen THREAD_SETUP failure without creating a thread."*
5. **"Token cost is measured and then thrown away — nothing persists it."** INTENDED. Ruling 3 accepted option (a): in-memory capture, asserted in tests and live proof, *"no new persisted/public concept in this zero-authority ticket"*; the reporting duty is the completion report, not the code. The service test asserts `tokenCount`/`archivedThreadCount` never appear in the persisted state file — that assertion *is* the ruling.
6. **"A failed write probe should mark the surface incompatible."** INTENDED, and the opposite is load-bearing: emb-49 §3 — a present-and-failed probe would drop Codex to `incompatible`; the test asserts `probes.length === 4` and tier `schema_attested` for all 7 failure codes.
7. **"The allowlist grew from 6 to 10, including a creating method."** INTENDED and priced. Ruling 1: *"allowlist 6→10 AUTHORIZED… the courtesy read stays — it is the founder's token-thrift stance applied to the user's quota, and it is a read (grants nothing)."*
8. **"The probe connector receives `item/started` while ordinary routes opt out — inconsistent."** INTENDED. Fence correction accepted in the analysis-phase findings: *"the probe-bearing connector must request `item/started` (ordinary routes keep their opt-out) or interrupted tools could evade the zero-tool-activity assertion."*
9. **"No journal entry for a compatibility/authority event."** INTENDED. Analysis-phase findings: *"NO journal action in this ticket (authority-transition activity belongs in emb-60 — accepted, consistent with downgrade discipline)."*
10. **"`thread/settings/updated` is accepted with a non-null `collaborationMode`."** INTENDED — named as an acknowledged in-scope fix in the budget-contest section.
11. **"`mkdtemp` failing before a cwd exists reports THREAD_SETUP, not TOOL_ACTIVITY."** INTENDED — the second acknowledged in-scope fix, verbatim.
12. **"`thread/archive` leaves a durable artifact rather than erasing."** INTENDED and founder-ruled: *"acceptable. One archived probe thread per Codex version may remain in history."*

That is twelve findings the written record can pre-empt. Everything in my PM-eyes list below is what it cannot.

---

## Items worth PM/founder eyes

1. **A second boot-fatal throw path was added, against an explicit acceptance criterion.** `executeCodexWriteProbe` throws `CODEX_FACTORY_ATTESTATION_INVALID` if the controller state root's dev/ino/mode/uid changes across the probe, or fails its 0700/owned/canonical check going in; `runCompatibilityProbesFor` re-throws it beside the `isEndpointGenerationChanged` carve-out; `runAutomaticCompatibilityProbesLocked` catches nothing; `start()`'s catch at `service.ts:966` calls `close()` and rethrows. **A compatibility-evidence probe with no authority can now kill the whole broker at boot, Claude included.** The engineer clearly thought this through — the test is named *"an unsafe controller state root **remains** fatal before Codex thread creation"*, and the code is a pre-existing house code that is already in `BOOT_REACTIVATION_TRUST_FAILURE_CODES` — and the practical exposure is small, since `GatewayStore.prepareOwnedDirectory` chmods the root to 0700 before probes run. But it contradicts both the Binding ("never-throw discipline") and emb-49 §4 ("add nothing else that throws… Claude is untouched in every failure mode"), and the deviation was never contested. **Your call:** ratify the fail-closed reading, or require the post-probe root check to settle as `THREAD_SETUP_FAILED` like every other failure. Cost of the latter is ~10 lines.
2. **v1.6 cannot ship with the current published claims.** README.md:39 and :236, SECURITY.md:185 and :350, docs/CONFIGURATION.md:90, docs/DASHBOARD.md:90, docs/GATEWAY-ARCHITECTURE.md:37/:773/:1053, plus the zh-CN mirrors, all state that Codex's bounded pre-write reads *"may include `initialize`, `thread/loaded/list`, and registration-time `thread/resume`, **but never `turn/start`**"*, and CONFIGURATION.md:90 adds *"These reads do not route a user message, retain history, or invoke `turn/start`."* After this diff the compatibility path may invoke `turn/start`, create a thread in the user's Codex, and leave an archived artifact. Docs are correctly outside this ticket's scope contract, so this is not an engineer miss — it is an unassigned ticket. Design law 6 makes it a release blocker for v1.6, not for the landing. Roughly 10 surfaces × 2 languages: a docs/copy ticket priced by surfaces.
3. **Shipping the un-revisable pin means a warning alert on every boot with no user-actionable remedy.** With `minimal` unavailable in the catalog, every boot produces `CODEX_WRITE_PROBE_MODEL_PIN_UNAVAILABLE` at severity `warning` into the dashboard attention list, and alerts render as bare safe codes with no copy. Zero tokens spent — the fail-safe works — but a permanent, unactionable warning is design law 6's "every remedy shown must work from where that user stands." This bundles with the queued founder pin decision: adopting the PM's "lowest effort the pinned model actually advertises" recommendation makes the alert disappear; retaining zero-spend fail-safe means deciding whether the alert ships, gets downgraded, or is suppressed until a passing generation exists.
4. **One unexplained change in a neighbour's test.** `test/gateway-providers.test.ts` bumps `waitFor(() => observed.endpointRefreshes.length === 1)` to a 2,000 ms timeout in the pre-existing "callback-published endpoint evidence is never republished by a retained se…" case — endpoint-transition territory, which the concurrent-seam partition assigns to swe3 (emb-62). Test-only, almost certainly CPU contention from the enlarged file, but a flake-tolerance widening in another owner's neighbourhood with no note is exactly what an adversarial reviewer will read as regression-masking. Ask for one sentence in SLICE READY.
5. **Minor scope-contract stretch, worth a nod rather than a contest.** The partition reserved "an owned-cwd helper adjacent" (singular) in providers.ts; the diff added two attestors, two comparators, two evidence types and `systemErrorCode` (~90 lines), plus a new `captureWriteCompatibilityProbeObservation` in service.ts beyond "the interface/context and `runAutomaticCompatibilityProbesLocked`". All adjacent, none in swe3's symbols, `trackedRoutes` only read. I'd accept it and tighten the wording next time.

## Overall taste verdict

This is the best-behaved sensitive ticket I've reviewed against this record: it bought the promise set and stopped, it kept every value judgment in a reviewed, greppable constant, it added not one user-facing concept, it proved zero-authority with a test rather than a sentence, and it came in at 1,041 of 1,050 source lines with formatting that argues nobody golfed to the number — a ticket whose headline artifact is a *declined* live probe and a measured cost of zero tokens is a ticket whose author understood that the fail-safe half is the deliverable. The written record did heavy work here: twelve of the findings a fresh reviewer will produce are already settled in the ticket, which is the strongest evidence yet that ruling-in-the-file beats re-litigating in review. What the record did not cover is where I had to guess, and the concentration is telling — every one of my PM items sits in the space *between* this ticket and its neighbours: a throw path that trades this ticket's never-throw promise against the repo's standing fail-closed instinct, published security copy that only becomes false once this lands, an alert whose acceptability depends on a founder decision still in flight, and a one-line timeout change in a concurrent owner's file. None of that is engineering failure and none of it should block the landing; it is the seam work a PM owns, and it wants one ruling, one docs ticket, and one sentence in SLICE READY. Land it.

---

## GAP LIST — judgments I made without a prior in the record

Ordered by how much the guess mattered.

1. **Never-throw vs. controller-integrity fail-closed.** The Binding says "never-throw discipline"; emb-49 §4 says "add nothing else that throws"; the repo's standing pattern makes `CODEX_FACTORY_ATTESTATION_INVALID` boot-fatal on OS-evidence violations and README:39 says only "unsafe OS evidence for Embassy-owned… state paths refuses broker startup" — which arguably *authorizes* this throw. Nothing reconciles them for a zero-authority probe. I guessed "flag for ratification, don't condemn." A ruling either way would have made this a one-line note or a hard finding.
2. **Who owns correcting the published "never `turn/start`" claims, and when.** emb-49 §2 says only that the allowlist widening "belongs in the implementation ticket's text, not in a diff." Whether that discharges the duty (the ticket does record it) or defers it (docs must still change before v1.6 ships) is unstated. I assumed defers-to-a-new-ticket. If the PM's view is "the claim stays true until emb-60 unlocks writes," my item 2 is wrong.
3. **Whether a permanently-firing, unactionable warning alert is shippable.** No standing rule on alert noise, no copy requirement for new safe codes, and emb-58 handled tier copy only. I applied design law 6 by analogy.
4. **What the concept budget actually counts.** "concepts: zero beyond emb-58's" is a delta with no enumeration, while aipm §4 defines concepts as "new states, error codes, options, or record types." Literally counted, this diff adds 7 error codes, 1 connector option, a 4-state probe phase, and ~6 record types. I ruled that promise-named codes are free because the Binding names them and Ruling 2 authorized the 7th — but that reading is mine, not the record's, and it is the difference between "budget met" and "budget blown 15×."
5. **The basis of "≤1,050 source lines."** Added, net, or final-file? All three pass here (1,041 / 1,034 / equivalent), so the guess was free — but a future contest at the margin will turn on it.
6. **Whether omitting `permissions` and `collaborationMode` from `thread/start` satisfies "fence declared."** emb-49 §1.3 lists "minimal `permissions`… `collaborationMode`/`multiAgentMode` off"; the analysis-phase findings cite "the permissions-conflict and collaborationMode-override cautions" but never state the resolution. The diff omits both fields entirely. I assumed omission *is* the resolution.
7. **Whether `thread/settings/updated` must be observed, or merely validated if present.** The diagnostic ruling says "verified via model/rerouted + settings echo as designed"; the implementation treats the echo as optional. Required-presence would be a materially stronger pin verification.
8. **Whether "no `thread/tokenUsage/updated` ⇒ TIMEOUT, never pass" is intended.** A pass requires `tokenCount !== null`. Ruling 3's reporting duty supports the strict reading, but nobody ruled that a server which doesn't emit token usage can never earn write coverage — and unknown #6 (actual token cost) was never measured live, so this path is untested against reality.
9. **Which safe code an unparseable `account/rateLimits/read` payload deserves.** `rateLimitConstrained` returns `null` on any shape it cannot parse, and the caller maps that to `THREAD_SETUP_FAILED`, not `RATE_LIMIT_CONSTRAINED`. Ruling 2 approved the predicate, not the failure mapping. The chosen code will read as wrong to an operator.
10. **Whether the generic provider boundary may carry Codex-shaped payload.** `GatewayCompatibilityProbeContext.forbiddenCodexThreadIds` reaches the Claude adapter too. No altitude rule exists in the record; I judged it acceptable-but-notable.
11. **Whether the write probe should ride the post-boot endpoint-refresh path.** Because `compatibilityProbeContext` is cached on the provider, `runCompatibilityProbesFor(candidate)` at the refresh call site (`providers.ts:4148` in base) will run a real write probe — and can throw the new fatal code from a path whose error handling differs from boot. emb-49 §4 lists generation change as a legitimate re-probe trigger, so I assumed intended, but the ticket never ruled that the probe rides refresh.
12. **The TTL cited in the cardinality ruling does not exist.** The ruling justifies the bound with "the persisted attestation + generation binding + **TTL** make boot-time re-probes the exception." emb-49 §3 proposed a 7-day TTL; no TTL exists at 3d574ce and this diff adds none. Either the rationale cites machinery that was never built (and boot-time re-probes are *not* the exception on a fresh state dir), or TTL is emb-60's. I could not tell which.
13. **The unexplained `waitFor` timeout bump** in an existing endpoint-transition test — no record entry, and it sits in the concurrent owner's conceptual neighbourhood.
14. **UUIDv7 strictness.** emb-49 §1.1 says "matches the UUID grammar"; `validUuidV7` requires the version-7 nibble and RFC variant bits. Defensible (the sentinel and route handles are v7), but a stricter fence than the words, unruled.
15. **Unreviewed numeric bounds:** `MAX_PROBE_TOKEN_COUNT = 1_000_000_000`, `model/list` `limit: 100` and the 100-entry parse cap, the 100,000-entry loaded-list cap. Each is a small value judgment the record never touched, and the record's own standard is that value judgments live in reviewed constants.
16. **Whether double-implementing assertions 2 and 5 across the connector/provider seam is wanted defense-in-depth or waste.** No reuse rule in the record; the pre-existing `assertOwnedPrivate` helpers in `codex-local-transport.ts` and `store.ts` are both module-private, so a third implementation was the cheap path — but nobody ruled that exporting one was out of bounds.
17. **Whether `writeProbeOverflow`'s single-slot memory is required.** Ruling 2 asked only that the 17th tuple return a frozen failure without creating a thread; remembering it (so `latestWriteCompatibilityProbeObservation` can alert) is ~20 lines the ruling did not order and did not forbid.
18. **What "SLICE READY reports actual against this number" must contain.** The budget ruling requires an actual-vs-target report and Ruling 3 requires the measured token count in the completion report (which live proof pinned at 0). Whether a 0-token, fail-safe-only run satisfies "the measured token count MUST appear" is a hair I split in the engineer's favour.

## PM rulings on the taste items (2026-08-16)

**Item 1 — the state-root throw: FAIL-CLOSED READING RATIFIED.** The never-throw criterion governs
probe failures; a controller state-root swap mid-probe is an OS-boundary trust violation — the
founder's named trust-model pillar — and the repo's standing, README-documented behavior ("unsafe
OS evidence for Embassy-owned state paths refuses broker startup") already makes exactly this class
boot-fatal via the same house code. The two written rules are reconciled, not in conflict: probe
outcomes never throw; trust-boundary violations always do. Recorded here so the next reviewer needs
no guess (gap 1 closed).

**Item 2 — ACCEPTED as a release blocker: filed as emb-64** (docs truth sweep, priced by surfaces,
blocks the v1.6 tag, not this landing).

**Item 3 — bundled into the queued founder pin decision** (the permanent warning's shippability is
a consequence of the pin choice).

**Item 4 — ALREADY RULED, reviewer lacked visibility**: the waitFor bump is the PM-approved emb-52
backlog-item-2 flake fix, ruled on this conversation and recorded in emb-52's ticket — a
cross-ticket ruling-visibility gap in the PM's record-keeping, now trial data (rulings should be
recorded in the ticket where the CHANGE lands, not only where the defect was found).

**Item 5 — accepted with the nod; partition wording tightens next time.**

**Honesty correction to the cardinality ruling above**: it justified the bound partly via "the
persisted attestation + generation binding + TTL"; NO TTL exists at this base and this diff adds
none (emb-49 §3 proposed one; it was never built). The bound stands on the one-shot map + persisted
attestation + generation binding alone — which suffices — but the ruling's stated rationale
overcited. Corrected here per gap 12; TTL, if ever wanted, is emb-60-or-later machinery.

**Gap-list disposition**: items 4/5 (concept-count basis, line-count basis) get standing
definitions at the next maintenance pass; items 6-9/11/17 fold into emb-60's design preconditions;
items 14-16 accepted as implemented. The full 18-item list is the primary input to the
agents/taste-reviewer.md extraction.
