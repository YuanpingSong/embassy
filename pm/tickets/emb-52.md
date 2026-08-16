---
id: emb-52
title: Runtime re-anchor must outlive the endpoint transition
kind: normal
size: 5
status: building
release: v1.6
updated: 2026-08-16
---

## Binding

**Why**: an App Server restart currently wedges the broker — routes go stale, `register-codex` is rejected, sends become unavailable — until the broker itself is restarted. Real users hit this every time the daemon restarts; the v1.5.0 endpoint-sentinel fixed route churn on upgrade, but the re-anchor still dies inside the transition itself.

**Promises (what must be true when done):**
1. After a same-path App Server restart (new endpoint generation, same identity), existing routes re-anchor without a broker restart.
2. `register-codex` is accepted immediately after the transition completes.
3. Sends (new and queued) flow after re-anchor, with delivery receipts.
4. The re-anchor leaves journaled evidence (an `endpoint_refreshed`-class event), and degraded state during the transition renders as degraded-with-a-reason, never as absence.

**Budgets**: size 5 (subsystem scope — routes/runtime re-anchor path); concepts: no new user-facing concepts, at most one new journal event kind. Tests: the promises, plus one manual live drill — kill and restart the daemon under a live pair, verify all four promises against the running broker.

**Scope contract**: to be fixed at dispatch; expected neighborhood is the gateway runtime/route modules. No dashboard or CLI surface changes beyond truthful status copy.

**Non-goals**: in-process broker succession (separate track); Codex write authority (emb-49).

## Background (hypotheses — re-verify against current code; stop and report if stale)

Root-cause trace from the v1.5 retro: the transition freezes the route set at T+250ms; a same-generation CHURN wall then rejects the re-anchor; fresh evidence is discarded at `service.ts:8364` (line number from 2026-08 trace — re-locate before relying on it). Ranked fix shape from the retro: let runtime re-anchor evidence survive the transition window rather than widening the wall.

---

## Dispatch note (2026-08-16, to codex-embassy-swe3)

Scope contract: `src/gateway/service.ts`, `src/gateway/store.ts`, `src/gateway/codex-local-transport.ts`,
`src/gateway/types.ts` (new journal event kind only), `test/**`. Anything beyond: contest before writing.
Handoff per house protocol: declared file list, evidence per promise, and the full `npm run check`
verdict printed as a value. Liveness confirmed this conversation (READY, conv_2ziJHYk0eS3_7oX3wL28TRts).
PM runs the live drill at landing (daemon kill+restart under the live pair) under founder-granted
restart authority.

## Contest and ruling (2026-08-16)

**Contest (swe3, before any edit)**: the dispatched scope contract excluded the transition owner.
Re-verified against HEAD: the freeze/track logic (providers.ts:3880-4010, after the 250ms recovery
timer at :3720-3815), the same-generation CHURN wall (providers.ts:4027-4133), and the only
transition-surviving evidence (`pendingEndpointRefreshEvent`, providers.ts:2827, 3998-4007,
4193-4268) all live in `src/gateway/providers.ts`; `service.ts` only consumes the callback.
Budget claim unchanged: E5, no new user-facing concepts.

**Ruling: ACCEPTED, immediately.** PM spot-check confirms the anchors (CHURN: 3 sites in
providers.ts vs 1 consumer site in service.ts; the refresh event is a providers.ts private field).
The scope contract now includes `src/gateway/providers.ts` and names `test/gateway-providers.test.ts`
explicitly (already covered by test/**). Budgets unchanged. The error was the PM's: the window was
drawn from the retro trace's consumer-site line number — the exact stale-evidence failure the ticket's
own Background warned about. Contest quality: exactly what the channel exists for.

---

## Adversarial review (2026-08-16, opus, frozen diff; reviewer restored tree byte-identical, md5-verified)

Tree restored and verified byte-identical to the frozen diff (per-file `git diff` md5s match the patch exactly).

# emb-52 adversarial review

Baseline: `test/gateway-providers.test.ts` 75/75 and `test/gateway-service.test.ts` 153/153 pass on the frozen tree. Both new mechanisms are load-bearing (ablating either fails the new tests). Two findings are reproduced with runnable tests; the rest are code-read.

---

## F1 — HIGH. The queued-context reanchor is unreachable on the selector/registration activation path, so a `register-codex`-driven restart still wedges the alias permanently

**Evidence:** `src/gateway/service.ts:8239-8266` returns from `applyCodexEndpointRefresh` for `deferActivation === true` **before** the loop at `:8296-8309` that calls the new `reanchorQueuedMessageContexts`. The second pass (`requiredRoute`) recomputes `previousRoutes` at `:7948-7953` from a fresh inventory — but pass 1 already ran `store.reanchorCodexRoutes` (`:8069`), so no G1-generation routes remain and `previous` at `:8302-8304` is always `undefined`.

**Empirical proof (instrumented full service suite, then reverted):** every `defer=true` pass is followed by a `required=true` pass with `prevRoutes=0`. One existing test already leaves an orphaned context:

```
EMB52 apply defer=true  required=false prevRoutes=1 contexts=1
EMB52 apply defer=false required=true  prevRoutes=0 contexts=1
EMB52 ORPHAN-CONTEXT msg=msg_cb91… alias=codex-main@this-mac auth=selected_route
```

That test (`"a selector refresh preserves pre-return queued ingress across the generation boundary"`, `test/gateway-service.test.ts:4038`) passes only because `FakeProvider.dispatch` settles synchronously. The real provider returns `{state:"accepted"}` and settles asynchronously, so the orphan bites.

**Reproduction** (written against the frozen tree, then removed): same shape as the new `"a real Codex provider reanchors runtime routes…"` test, but with `recoveryInitialMs: 60_000` so automatic callback recovery never fires and `register-codex` drives the whole transition. Result:

- `register-codex` accepted immediately ✔ (promise 2)
- durable G2 reanchor ✔ (promise 1)
- queued mail dispatched, `deliveryStatus === "delivered"` ✔
- route returns to idle ✔
- **the next `sendToCodex` never reaches `turn/start` — the alias is dead.** ✘ (promise 3)

Mechanism: `acceptProviderDeliveryLocked` (`:6027`) copies the still-G1 `targetBindingKey` into `providerTurnContinuations`; the `turn/completed` callback is then rejected by the generation check in `contextTargetBinding` → `onDelivery` (`service.ts:1471-1482`, `:7278-7286`), `finishProviderTurnContinuationLocked` never runs, and `activeDispatchByTarget` stays pinned, so `dispatchOne` early-returns at `:6869` forever. This is byte-for-byte the same failure the `ABLATE_REANCHOR` run produces on the callback path — i.e. the exact wedge the reanchor was added to remove.

**Confirmed fix shape:** adding the same reanchor loop before the `deferActivation` return (guarded probe, using `activatedRoutes` + `previousRoutes`) makes the repro pass. Better still, reanchor at the durable-reanchor site (`:8067-8121`) so both passes are covered.

Note this is a *pre-existing* defect, not a regression — but it is unfixed on precisely the path the retained-evidence change newly enables, so promise 3 is only half-satisfied.

---

## F2 — HIGH. Retained evidence lets one transition be published twice with divergent route sets, permanently poisoning endpoint transitions

**Evidence:** `providers.ts:4024-4031` sets `pendingEndpointRefreshEvent` for *every* compatible refresh, including `delivery === "callback"` ones that were already handed to the controller via `publishEndpointRefresh`. `retainedEndpointRefreshResult` (`:3860-3873`) does not exclude those, and re-wraps the event as `delivery: "selector"`. `reserveSelectorRefresh` (`:4186-4195`) then marks it claimed, which makes it eligible for `emitSelectorRefreshFallback` (`:4197-4218`) — a path that **mutates the retained event by filtering out a route handle and re-publishes it**.

Before this diff, exactly one publish channel existed per transition: `emitSelectorRefreshFallback` returns early for `delivery === "callback"` (`:4201`), and a selector joining an in-flight refresh suppresses the callback publish (`:3886`, `:4028`). The retained path breaks that invariant.

**Reproduction** (provider-level, deterministic, since removed):

```
firstFactory.endpointGenerationChanged = true;
firstFactory.transports[0].disconnectUnexpectedly();   // callback refresh publishes E {routes:[THREAD_ID]}
secondFactory.transports.at(-1).disconnectUnexpectedly();
secondFactory.endpointGenerationChanged = true;         // second App Server restart lands mid-window
await assert.rejects(provider.selectRoute({alias:"codex-main@this-mac", routeHandle: THREAD_ID}));
// → observed.endpointRefreshes.length === 2, second.routes === []
```

With `ABLATE_RETAINED=1` (retained lookup disabled) only **one** event is published — confirming this is new.

**Consequence:** `endpointRefreshCallbackKey` (`service.ts:609-646`) includes `routes`, so E and E′ have different keys. The retained path only fires while `pendingEndpointAttestation` is still set — i.e. exactly while the controller has not yet drained E — and the selector runs under the same `"service"` mutex as the callback worker, so E is *guaranteed* still sitting in `this.endpointRefreshCallback`. `enqueueEndpointRefreshCallback` (`:1747-1755`) therefore calls `poisonEndpointRefreshCallbacks`, and `endpointRefreshCallbackPoisoned` is never reset anywhere except `close()` (`:1102`). Every subsequent transition throws `CODEX_ENDPOINT_REFRESH_CONFLICT` — "requires a clean broker restart."

This is fail-*closed* (no unsafe write, no wrong route), but the outcome is the literal wedge in the ticket's **Why**: an App Server restart bricks the broker until the broker is restarted. Trigger is the ticket's own attack-surface-2 case: a second restart landing mid-recovery.

Suggested containment: either exclude already-published (`delivery === "callback"`) events from `retainedEndpointRefreshResult`, or make `emitSelectorRefreshFallback` skip re-publishing when the retained event was previously published under a different key.

---

## F3 — MEDIUM-LOW. Deferred route observations are silently dropped when the transition slot is poisoned

`service.ts:1822` declares `deferredRouteObservations` **inside** the `while` body, and the replay loop is at `:1909-1915` — after the `continue` at `:1877`. A provider callback can synchronously poison the slot mid-batch (`enqueueEndpointRefreshCallback` → `poisonEndpointRefreshCallbacks`, `:1761-1774`, which runs outside the mutex), setting `endpointRefreshConflictPending`; the batch then takes `:1864` → `:1877` and the whole deferred array is garbage-collected unreplayed.

Downgraded because `failClosedEndpointRefreshConflict` (`:1961-2014`) marks the affected connector offline and forces every matching route to `stale`, so the lost observations cannot open anything — worst case a fresher `"idle"` is discarded while the route is already being forced stale. Still, the drop is unconditional and unlogged; moving the array outside the loop (or replaying before each `continue`) costs nothing.

Related, lower: the filter at `:1837-1839` only defers handles present in `pendingRefresh.routes`. A G2 observation for the *freshly selected* handle (not in the evidence) is still processed inline and dropped by `onRouteState`'s binding lookup at `:8401-8408`. Registration sets that state explicitly afterwards, so it is masked — but the fix is asymmetric.

---

## F4 — LOW. Behavior widening: `recovered` removal changes stale-route semantics for every route, not just transitions

Removing `MessageContext.recovered` (`:460`, `:6836`) makes the stale-Codex branch in `dispatchOne` (`:6951-6962`) requeue unconditionally. No leftover references (`grep` clean), and `store.requeueInFlightMessage` uses `state.queue.unshift` (`store.ts:4699`) so head-of-line order is preserved and there is no dispatch spin (the `scheduleDispatch` was correctly dropped along with the terminal settle).

The scope note: this is not transition-scoped. A Codex route that is stale *permanently* (not mid-restart) now holds mail queued until each message's deadline instead of failing fast with `CODEX_ROUTE_STALE`, and every retry appends another `"held"` journal event. Truthful (queued + route stale-with-reason), fail-closed, and arguably what promise 3 wants — but it is a global semantic change riding in on a transition ticket, and the renamed test (`"…terminally fails held work"` → `"…preserves held work"`) is the only place it's recorded. Worth an explicit line in the handoff.

---

## F5 — LOW. Sticky retained claim with no release on controller-side failure

`pendingEndpointRefreshSelectorClaimed` is only cleared when the event is replaced (`:4026`), on `acceptCompatibilityAttestation` (`:2941`, `:2972`), on incompatible refresh (`:3928`), or on full `close()` (`:3510`). If a selector claims retained evidence, `ensureRoute` succeeds, and the *service-side* activation then fails (e.g. `requireNativeContinuity` at `service.ts:8311`), the provider never learns and the retained channel is closed for that generation. Recovery then depends solely on the 3-attempt `endpointActivationRetry` (`:4235-4282`); after it exhausts, `pendingEndpointAttestation` stays set, `endpointUnavailable` stays true, and every selector falls through to `assertReady()` → `CODEX_PROVIDER_UNAVAILABLE`. The wedge shape pre-exists; the retained path adds one more way to enter it.

Also: `close()` clears `pendingEndpointRefreshEvent` at `:3471` without resetting the new flag. Self-heals at `:4026`, so cosmetic — but it's the one clear-site the diff missed out of five.

---

## Checked and clean (no finding)

- **Double claim / wrong selector.** `retainedEndpointRefreshResult` → `stageRefreshedRoute` → `reserveSelectorRefresh` runs with no intervening `await` (`:3160` → `:3144`), so the claim is atomic against the microtask queue. A second selector gets `undefined` and falls to `assertReady()` → retryable `CODEX_PROVIDER_UNAVAILABLE`. Fail-closed.
- **Wrong generation / provider.** `event.current.endpointGeneration !== this.factory.endpointGeneration` (`:3868`) plus the controller's own re-validation at `service.ts:7893-7916` and the callback filter at `:1616-1630`.
- **Uncovered route handle.** The retained path lets a selector for a handle *not* in `event.routes` claim the evidence (the new provider test does exactly this). Sound: the evidence never grants that handle authority — `service.ts:8206-8238` requires an independently-durable, uniquely-owned G2 route for the `requiredRoute`, else `CODEX_ENDPOINT_REFRESH_MISMATCH`.
- **Schema-attested / incompatible survival.** `schema_attested` events are `outcome: "compatible"` and *are* retainable, but the connector is read-only (`writableReady === false`) and `applyCodexEndpointRefresh:8032-8040` throws `CODEX_MONITOR_ONLY` whenever `requiredRoute`/`deferActivation` is set. Incompatible clears the retained event at three sites. No write can escape.
- **Deferral ordering.** G2 observations can only be queued after `this.routes.set` at `providers.ts:4005`, which is strictly after the frozen states are read at `:3979` — so a deferred observation is always at-or-fresher than the evidence it is replayed behind. Replay order is preserved and each event replays exactly once. Replay after a *failed* transition hits `onRouteState`'s binding lookup and is dropped (fail-closed). `scheduleDispatch` is `setImmediate` + mutex (`:7235`), so it can never outrun the in-lock replay.
- **Duplicate journaling.** `activatedEndpointRefreshes` short-circuit (`:7917-7922`) plus `endpointRefreshActivityKeys` dedupe (`:8326`) hold under the new double-delivery; the new test's `codexEndpointRefreshEvents.length === 1` assertion is real coverage.
- **No duplicate write from the requeue path.** The item is dequeued but not yet handed to the provider at `:6953`; `requeueInFlightMessage` validates the exact admitted byte count and restores queue position.

**Pre-existing, out of diff, but bears on promise 4:** the `endpoint_refreshed` activity event is appended at `:8336` before `changed()` (`:8351`) and before the final `acceptCompatibilityAttestation` (`:8359`); a throw at `:8354`/`:8359` leaves a journaled `outcome: "accepted"` for a transition that then failed closed, and the dedupe key prevents any correction. Not introduced here.

---

**Verdict:** the two mechanisms are individually sound and correctly fail-closed under everything I threw at them, but the change ships **half a fix (F1)** and **opens a new permanent-poison path (F2)** — both of which reinstate the wedge the ticket exists to eliminate. I'd hold landing on F1 and F2.

## PM ruling on review findings (2026-08-16)

Independent gate: PASS (758/758, isolated worktree). Review verdict adopted — **landing HELD on F1+F2**:
- **F1 (blocking)**: violates promise 3 on the register-codex path; reviewer's confirmed fix shape
  (reanchor at the durable-reanchor site so both passes are covered) is the recommended repair.
- **F2 (blocking)**: reinstates the ticket's Why under a second mid-recovery restart; containment =
  exclude already-published callback events from retention, or skip re-publish under a changed key.
- **F3 + F5 (include, cheap)**: move deferredRouteObservations outside the loop / replay before
  continue; add the missed clear-site in close().
- **F4 (accepted as intended, document-only)**: the stale-route requeue widening is truthful and
  fail-closed; document in the completion report and release notes — no code change.
Budget: corrections expected within the existing E5; contest if not. Window unchanged.
