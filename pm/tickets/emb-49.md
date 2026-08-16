---
id: emb-49
title: Codex write-attestation probe — design pass
kind: investigation
size: 2
status: landed
release: v1.6
updated: 2026-08-16
---

## Binding

**Why**: under the v1.5 evidence ladder, Codex sits monitor-only because read probes never earn turn/start authority (design law 3: evidence must cover the authority it grants). A bounded write-attestation probe — a real turn/start against a disposable thread — is the only evidence class that could legitimately raise Codex to writable.

**Deliverable**: a design report, not code. It must answer: how a disposable thread is created and provably isolated; what the bounded probe writes and how the blast radius is capped; what evidence the probe records and its shelf life (probe evidence goes stale against moving versions); how failure quarantines (provider-local, never boot-fatal); and what the ladder transition looks like in the journal and on the dashboard.

**Probe cost requirement (founder, 2026-08-15)**: the probe turn itself must pin the provider's cheapest available model at the lowest reasoning effort — today that is GPT-5.6 Luna at minimal effort — so attestation never spends user tokens beyond the minimum. The design must state how the model/effort pin works and how the probe fails safe (no attestation, no retry storm) if the pin is unavailable.

**Budgets**: size 2, investigation — read-only against the codebase; any live probing happens only against a disposable thread and only if the design pass says it's safe, otherwise it stays on paper.

**Non-goals**: no probes against real user threads; no implementation ships from this ticket itself. Founder pre-authorization (2026-08-15): if the design yields good evidence of a concrete implementation that solves the Codex version-certification gap, the implementation is priced as its own ticket and may fold into v1.6.

---

## Completion report (2026-08-16, opus design agent)

# emb-49 — Codex write-attestation probe: design report

**Status:** design pass complete. Read-only. No code changed, no probe run, no thread created, the broker was not contacted. One new class of evidence was obtained that the ticket did not anticipate: I read the App Server surface directly out of the local Codex 0.147.0 binary's string table (`~/.codex/packages/standalone/current/bin/codex`, `strings` only — never executed). That converts several of emb-54's open questions into facts.

Evidence marks: **[src]** read in Embassy source · **[bin]** recovered from the Codex 0.147.0 binary's serde/method string tables · **[inf]** reasoned · **[unk]** stated unknown.

---

## 0. The surface, as it actually is

**Embassy's closed method allowlist is 6 methods** — `CODEX_APP_SERVER_V1_METHODS` at `/Users/yuanpingsong/Desktop/repos/embassy/src/gateway/codex-app-server.ts:14`: `thread/loaded/list`, `thread/resume`, `thread/unsubscribe`, `turn/start`, `turn/steer`, `turn/interrupt`. **[src]** The file's own doc comment calls this the reviewed set and says steering "never authorizes an interrupt or a generic/public JSON-RPC escape hatch."

**App Server 0.147.0 exposes far more, including everything a write probe needs.** **[bin]** Recovered `ClientRequest` variants and wire methods include `thread/start`, `thread/fork`, `thread/archive`, `thread/delete`, `thread/read`, `thread/list`, `thread/rollback`, `model/list`, `modelProvider/capabilities/read`, `account/rateLimits/read`, `account/usage/read`. Notifications include `thread/started`, `turn/started`, `turn/completed`, `item/completed`, `thread/tokenUsage/updated`, and — critically — **`model/rerouted`** and `model/verification`.

**Reasoning effort is a real, enumerated, settable parameter.** **[bin]** The enum is `none | minimal | low | medium | high | xhigh | max | ultra`. `TurnStartParams` has 20 fields and demonstrably includes `effort`, `serviceTier`, `approvalPolicy`, `approvalsReviewer`, `sandboxPolicy`, `permissions`, `personality`, `outputSchema`, `collaborationMode`, `multiAgentMode`, `environments`, `runtimeWorkspaceRoots`, `additionalContext`, `clientUserMessageId`, `responsesApiClientMetadata`. `ThreadSettings` has 13 fields: `cwd`, `approvalPolicy`, `approvalsReviewer`, `sandboxPolicy`, `activePermissionProfile`, `modelProvider`, `serviceTier`, `effort`, `collaborationMode`, `multiAgentMode`, `personality`, plus two field names I could not recover positionally (serde interns each name once; these two appeared earlier in the table). One of the two is almost certainly `model`. **[unk — see §9.1]**

**`gpt-5.6-luna` is a real model slug in this build.** **[bin]** The catalog also contains `gpt-5.6`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-pro`, `gpt-5.5`, `gpt-5.4-mini`, `gpt-5.3-codex`. `model/list` returns a `Model` struct of 17 fields: `displayName`, `modelSpecialty`, `hidden`, `supportedReasoningEfforts`, `defaultReasoningEffort`, `inputModalities`, `supportsPersonality`, `additionalSpeedTiers`, `serviceTiers`, `defaultServiceTier`, `isDefault`, `upgrade`, `upgradeInfo`, `availabilityNux`, + 2 interned. **There is no price field.** That single absence determines the whole shape of the founder's cost requirement (§6).

**Sandbox and approval vocabularies exist and are strict.** **[bin]** `sandbox_mode ∈ {danger_full_access, workspace_write, read_only}`; `approval_policy ∈ {on_request, on_request_auto_review, never, unless_trusted}`. `read_only` + `never` is a real, enforceable tool fence.

---

## 1. Disposable thread creation and isolation proof

### The only viable creation path

`thread/start` against the **Desktop-owned** App Server, through Embassy's existing attach-only proxy. **[inf, from src]** The alternatives fail:

- **`thread/fork`** derives from a real user thread. Rejected outright — it inherits history.
- **An Embassy-owned second App Server with a throwaway `CODEX_HOME`** gives perfect isolation and zero pollution of the user's thread list, but the throwaway home has no `auth.json`. Making it work means copying credentials, which `GATEWAY-ARCHITECTURE.md:1013` forbids absolutely: Embassy "does not copy, print, persist, or manipulate authentication material." **This option is closed by an existing rule, not by difficulty.** Point `CODEX_HOME` back at `~/.codex` and you are writing rollouts into the user's history again with none of the isolation.
- **`thread/start` on the Desktop server** is the only path that touches no credentials. Its cost is honest and must be stated: the probe thread is created *in the user's Codex*, persists a rollout, and appears in their thread list until archived or deleted.

### Isolation is proved by assertion, not by construction

Because the thread lives in the user's Codex, "isolated" cannot mean "in a sandbox Embassy owns." It has to mean six machine-checked facts, every one of which fails the probe if it does not hold:

1. **Fresh identity.** Snapshot `thread/loaded/list` before `thread/start`; assert the returned `threadId` is absent from that set, matches the UUID grammar, and is not any registered route handle. (Embassy already reserves a sentinel probe thread id, `00000000-0000-7000-8000-000000000000` at `providers.ts:87` — the write probe needs a *real* id, so that constant stays for the read path only.) **[src]**
2. **Owned, empty, private cwd.** `cwd` is a directory Embassy creates this boot at mode 0700 under the controller-owned state root, validated by the existing owned-path attestor before use — never the user's home, never a Claude workspace, never a temp root. `GATEWAY-ARCHITECTURE.md:1042-1046` already rejects filesystem root and temp roots as workspaces; the probe dir must clear the same bar.
3. **Tool fence declared.** `sandboxPolicy: read_only`, `approvalPolicy: never`, minimal `permissions`, empty `environments`, empty `runtimeWorkspaceRoots`, empty `dynamicTools`, `collaborationMode`/`multiAgentMode` off. **[bin — all are real fields]**
4. **Tool fence observed.** Zero notifications correlated to the probe `threadId` of kind `item/commandExecution/*`, `item/fileChange/*`, `item/mcpToolCall/*`, `item/permissions/requestApproval`, `serverRequest/*`. One such notification is a probe **failure**, not a warning.
5. **Cwd unchanged.** Re-stat after the turn: entry count still zero, mtime unchanged.
6. **Cleanup confirmed.** `thread/archive` (or `thread/delete`), then `thread/unsubscribe`, then re-list and assert the probe thread is gone from the loaded set. Unconfirmed cleanup is its own loud safe code (§4) because it means an artifact leaked into the user's history.

The architecture's existing standard for a probe is exactly this shape — `GATEWAY-ARCHITECTURE.md:805-827` records prior probes that "emitted booleans only and never printed or retained the identifier." The write probe must hold that line: it emits pass/fail and a bounded token count, never the thread id, never the model's reply text.

---

## 2. The bounded write and its blast-radius cap

**What it writes:** one `turn/start` carrying one fixed, compile-time-constant input string — never model-supplied, never user-supplied, never templated. The existing connector already sends `input: [{text, type:"text"}]` at `codex-app-server.ts:1228`. **[src]**

**What it asserts** is protocol correlation, not content: `turn/started` carrying the exact `threadId` and a `turn.id`, then `item/completed` carrying the exact top-level `threadId` + `turnId`, then `turn/completed`. This is precisely the correlation contract the connector already validates for real traffic (`GATEWAY-ARCHITECTURE.md:829-839`), which is the point — **the authority being attested is "`turn/start` on this build produces a correctly correlated terminal turn," which is the exact authority Embassy needs and the exact thing no read probe can establish.** Design law 3 is satisfied by construction, not by argument.

**Blast-radius cap, enumerated:**

| Bound | Mechanism | Status |
|---|---|---|
| One thread | `thread/start`, id asserted fresh | new |
| One turn | single `turn/start`, never re-sent | new |
| Fixed input | source constant | new |
| No tools | `read_only` + `never` + observation fence | new |
| Wall-clock bound | reuse `armTurnWatchdog()`, then `turn/interrupt` → `thread/archive` | **[src]** exists |
| Reply size bound | reuse `maxReplyBytes` / `MAX_TRANSIENT_REPLY_BYTES` (64 KiB) | **[src]** exists |
| One attempt per boot | per-(version, endpointGeneration) one-shot set; precedent is `handledIncompatibleEndpointRefreshes` | **[src]** precedent |
| Never on a real route | probe thread never enters `routeStates`, the store's routes, the delivery machine, or the provenance envelope | new |
| No retry on ambiguity | inherit the standing rule at `GATEWAY-ARCHITECTURE.md:1098` | exists |

**The security cost that must not be buried:** this widens the reviewed allowlist from 6 methods to 9 (`thread/start`, `thread/archive`, `model/list`), and `thread/start` would be **the first creating method Embassy holds**. That is a SECURITY.md-relevant change and belongs in the implementation ticket's text, not in a diff.

---

## 3. Evidence recorded, and its shelf life

### The cleanest way to record it: a probe name, not a new field

`CompatibilityAttestation` (`compatibility.ts:47`) is validated on load by `isPersistedCompatibilityAttestation`, which does **exact key-set matching** (`compatibility.ts:258-268`). **[src]** And `store.ts:1636-1641` rejects the *entire* state file if any single attestation fails that validator. **[src]** Consequence, and it cuts both ways:

> **Adding any new field to `CompatibilityAttestation` — including a `writesCovered` boolean — makes v1.6-written state unloadable by a v1.5 binary. So does adding a fourth tier, since `compatibilityTiers` is a closed validated union.** `service.ts:907-908` states downgrade-safety as an explicit requirement: "A failed upgrade must leave the prior on-disk schema usable by the previous binary."

The escape is already in the schema. `isPersistedCompatibilityAttestation` validates the `probes` array only by name pattern (`/^[a-z][a-z0-9_]{0,63}$/`), uniqueness, capacity 32, and the pass↔no-code invariant — **it does not check probe names against any list** (`compatibility.ts:142-179`). **[src]** So:

**Record write coverage as a fifth Codex probe named `write_attestation`.** A v1.5 binary loads a v1.6 five-probe record without complaint, declines to re-admit it (strict `isCompatibilityAttestation` runs only on fresh writes), and overwrites the same `(surface, version)` cache key with its own four-probe record on next boot. Downgrade-safe by construction, no new persisted concept, and the tier stays a pure function of probes + version exactly as today.

`writesCovered` then becomes a **derived** predicate: `tier === "schema_attested" && probes.some(p => p.name === "write_attestation" && p.outcome === "pass")`, exposed as a computed field on `PublicCompatibilityCheckSnapshot` (`types.ts:394`) — which is a public-snapshot type, not a persisted one, so widening it is free.

### A failed write probe must not be a failed probe

This is the sharpest finding in the whole pass. Under `evaluateCompatibilityAttestation` (`compatibility.ts:216-231`), **any** probe with `outcome: "fail"` forces `tier = "incompatible"`. **[src]** So if the pin is unavailable, or the account is rate-limited, or the network hiccups, a naively-added write probe would drop Codex from today's `schema_attested`/monitor-only to `incompatible` — firing an error-tone runtime alert and a worse quarantine than the status quo. An unavailable model pin is not evidence of incompatibility.

**The fix is to make `write_attestation` an optional, present-only-on-pass probe.** `normalizeProbes` relaxes from "exactly this ordered set" to "exactly this ordered required prefix, optionally followed by known optional probes"; same for `isCompatibilityAttestation`. Absence means no write coverage, which means today's behavior. The probe is never recorded as present-and-failed. The alternative — a third `"skipped"` outcome — changes the persisted probe validator on both binaries and is downgrade-hostile. Rejected.

### Shelf life

**Today there is none.** Nothing in the codebase reads `checkedAt` for expiry; eviction is capacity-only (16 records, `store.ts:110`), and the read probes simply re-run every boot, so freshness is implicit. **[src]** A write attestation is the first evidence you would want *not* to re-derive on every boot, so it is the first that needs an explicit shelf life. Proposed:

- **Primary binding: `(surface, exact version, endpointGeneration)`.** Version is already the cache key; endpoint-generation change already invalidates every route (`GATEWAY-ARCHITECTURE.md:1070`). Generation binding is the right invalidator because it is causal, not temporal.
- **Backstop: a wall-clock TTL.** The same version string can be reinstalled or re-signed. Start at 7 days. Note plainly that TTL length is a direct multiplier on token spend — a 1-day TTL is a 7× cost increase for no additional safety once the generation binding holds.
- **Immediate void on:** Codex binary path/inode change (the attestor already stats this), any `initialize`/`thread/resume` schema rejection, any `model/rerouted` on a probe turn, and an Embassy release upgrade.
- **The one gap:** endpoint generation cannot be stored *in* the attestation (key-set validator). It has to live in an Embassy-side table keyed by the cache key. That is the single place this design needs a side channel, and it should be called out in the implementation ticket rather than discovered during it.

The probe should also record the observed token count from `thread/tokenUsage/updated` **[bin]** as a bounded integer — the honest cost evidence, and the only way the founder ever learns what attestation actually costs.

---

## 4. Provider-local quarantine on failure

**Hard constraint, verified in source.** `runAutomaticCompatibilityProbesLocked()` is called at `service.ts:921`, inside `start()`'s try block, whose catch at `service.ts:966-973` calls `this.close()` and rethrows. **[src]** Anything the write probe throws kills the entire broker at boot — Claude included. The existing read probes already respect this: `runCompatibilityProbesFor` catches everything and returns `failedProbe(...)` results, with exactly one deliberate rethrow, `isEndpointGenerationChanged(error)` at `providers.ts:3013`. **[src]**

**The write probe must inherit that discipline exactly: catch everything, return results, preserve the single generation carve-out, add nothing else that throws.** That is the acceptance criterion I would write verbatim into the implementation ticket.

**On any failure, the provider-local effect is precisely today's v1.5 state** — `incompatibleProviderSurfaces.set(providerSurfaceKey("codex", hostId), "CODEX_MONITOR_ONLY")` at `service.ts:1316-1319`. The write probe can only ever *raise* Codex out of monitor-only; failing it must be a bit-for-bit no-op against v1.5 behavior. Claude is untouched in every failure mode.

**New safe codes** (all satisfying `SAFE_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/`), surfaced as runtime alerts and connector `safeErrorCode`s rather than as failed probes:

- `CODEX_WRITE_PROBE_MODEL_PIN_UNAVAILABLE` — pin absent, hidden, or lacks `minimal`
- `CODEX_WRITE_PROBE_MODEL_REROUTED` — `model/rerouted` observed; the pin was not honored
- `CODEX_WRITE_PROBE_THREAD_SETUP_FAILED`
- `CODEX_WRITE_PROBE_TOOL_ACTIVITY_OBSERVED` — the fence leaked; this one is serious
- `CODEX_WRITE_PROBE_TIMEOUT`
- `CODEX_WRITE_PROBE_CLEANUP_UNCONFIRMED` — **the loud one**; a thread may have leaked into the user's Codex history

**Retry-storm control.** One attempt per `(version, endpointGeneration)` per broker process, held in memory. No timer-driven retry, ever. Negative results are *not* persisted as attestations (persisting a failure would re-fire alerts on every read). Re-probe happens only on three user- or environment-initiated triggers: explicit `register-codex`, an endpoint-generation change, or a version change.

---

## 5. Journal and dashboard rendering of the transition

**Journal — today there is nothing to extend.** `gatewayActivityActions` (`types.ts:509`) holds 11 actions and **none of them is compatibility-related**; tier transitions are simply not journaled. **[src]** They surface only through the persisted attestation, the connector's `safeErrorCode`, and runtime alerts. Two options:

- **(i) Add one action, `write_attested`,** with `outcome: "accepted" | "rejected"` and `aliases: []`. This is the honest place for "Codex became writable at 14:02 on evidence X" and it is one row per transition. Cost: `gatewayActivityActions` is a closed union that is persisted and dashboard-rendered, so an old binary's activity-event validator may reject the unknown action — the same downgrade trap as tiers. **I did not read that validator. [unk — §9.5]** Verify before committing.
- **(ii) Reuse the existing `codexEndpointRefreshEvents` journal,** which already records compatibility outcomes for the Codex surface and already has a capacity bound. Zero schema risk.

Recommend (i) if the validator turns out to be permissive, (ii) if not. Do not skip journaling: a silent authority elevation is the one outcome the founder should never get.

**Dashboard.** The "Provider compatibility" table renders 8 columns at `dashboard.ts:633`/`:712`, is built at `dashboard-model.ts:1271-1287`, and is hard-capped `.slice(0, 2)`. **[src]** The tier cell renders `compatibilityTier.<tier>` from three copy files (`dashboard-copy.ts`, `.en.ts`, `.zh-CN.ts`).

Cheapest correct rendering: **do not add a ninth column.** Change the tier pill's label when writes are covered. Today `compatibilityTier.schema_attested` reads *"Live schema probes passed; build not tested by this release"* (`dashboard-copy.en.ts:316`). Add a sibling key — *"Live read and write probes passed; build not tested by this release"* — plus zh-CN. The operator sees the distinction in the place they already look, and no table geometry changes.

Two existing copy strings must stop firing for a writes-covered Codex: `guidance.providerIncompatible` ("Provider build is write-fenced") and `app.routes.monitorOnlyReason`. The second resolves itself — `monitorOnlyCodexRoutes` keys off route `safeErrorCode === "CODEX_WRITES_DISABLED"` (`dashboard-model.ts:1308`), which clears once writes actually unlock. The first needs an explicit guard. `live-dashboard-app/app-types.d.ts` mirrors the model and takes the same field.

---

## 6. The founder's cost requirement: the model/effort pin

### "Cheapest" is not discoverable — so the pin must be a constant

The `Model` struct has 17 fields and **no price, no cost tier, no token rate**. **[bin]** `modelSpecialty` and `additionalSpeedTiers` exist but describe capability, not cost. There is no API answer to "which model is cheapest." Therefore:

**`CODEX_PROBE_MODEL_PREFERENCE = ["gpt-5.6-luna"] as const` and `CODEX_PROBE_EFFORT = "minimal"` are release-pinned source constants**, sitting beside `CODEX_APP_SERVER_WRITABLE_VERSIONS` and reviewed on the same cadence. The founder's "today that is GPT-5.6 Luna at minimal" becomes a literal, greppable, single-line policy statement rather than an emergent runtime choice. That is the correct place for it: it is a value judgment, and Embassy's design consistently puts value judgments in reviewed constants.

### How the pin is applied and verified

1. **Resolve.** Call `model/list`. Take the first preference entry that is present, not `hidden`, and whose `supportedReasoningEfforts` includes `minimal`. **[bin — all three fields confirmed]**
2. **Pin at both levels.** Set `model` + `effort: "minimal"` in `ThreadSettings` at `thread/start`, and repeat `effort: "minimal"` on `TurnStartParams` at `turn/start`. Belt and braces, because `TurnStartParams.effort` is confirmed **[bin]** while `TurnStartParams.model` is not **[unk — §9.1]**; the thread-level setting covers the gap either way.
3. **Verify the pin held.** Subscribe to **`model/rerouted`** **[bin]**. If the server reroutes the probe turn to a different model, the pin was not honored — void the attestation, no write coverage, safe code `CODEX_WRITE_PROBE_MODEL_REROUTED`. This is the difference between *requesting* the cheapest model and *proving* you got it, and it is the only reason the founder's requirement is verifiable at all.
4. **Record the cost.** Capture the bounded token count from `thread/tokenUsage/updated`.

`none` is also a valid effort value **[bin]** and would presumably be cheaper still, but it is not what the founder said and per-model support is unverified. Default `minimal`; flag `none` as a founder decision.

### Fail-safe

Any of — preference list empty against `model/list`, chosen model `hidden`, `minimal` unsupported, `model/list` rejected, reroute observed — produces **no `write_attestation` probe at all** (per §3: optional, present-only-on-pass), a `CODEX_WRITE_PROBE_MODEL_PIN_UNAVAILABLE` alert, and today's monitor-only state. No turn is started, so nothing is spent. The one-shot-per-generation guard means a permanently unavailable pin costs exactly one `model/list` call per boot and zero tokens, forever.

**One addition I would make and price in:** call `account/rateLimits/read` **[bin]** before probing and decline when the account is near a limit. "Never spend user tokens beyond the minimum" read honestly includes "never burn a user's last few requests on self-diagnosis."

---

## 7. What tier a passing write probe earns

**It earns `schema_attested`, and that is already the right answer.** `GATEWAY-ARCHITECTURE.md:1050-1051` defines the tier as: *"a fully probed same-major build is `schema_attested` and writable only where the probes cover writes."* **[src]** The ladder's law is already coverage-shaped. The gap is not that a tier is missing — it is that the attestation does not record *which authority the probes covered*, so "writable where probes cover writes" has never been satisfiable in practice. Codex's four probes are all reads, so `service.ts:1311-1319` pins it to `CODEX_MONITOR_ONLY` and the clause has been dead text since v1.5.

**Recommendation: no fourth tier. Write coverage is a probe name (§3), and `writesCovered` is a derived boolean on the public snapshot.** Three reasons: the doc's law is coverage-shaped, not tier-shaped; a fourth tier is downgrade-fatal via the closed `compatibilityTiers` union; and a new persisted *field* is equally downgrade-fatal via exact key matching. The probe-name route is the only one of the three that survives a v1.6 → v1.5 rollback.

### The finding that resizes this ticket: the tier is not the gate

Even a `certified` attestation does not by itself unlock writes. `LocalCodexGatewayProvider.acceptCompatibilityAttestation` (`providers.ts:2947-2953`) requires:

```ts
const writableCertified =
  attestation.tier === "certified" &&
  CODEX_APP_SERVER_WRITABLE_VERSIONS.includes(attestation.version) &&
  this.factory.writableReady &&
  this.factory.writeCompatibility !== null;
```

and `validateCodexFactory` (`providers.ts:2697-2734`) refuses to construct a factory with `writableReady` or non-null `writeCompatibility` unless the version is an **exact string match** in `CODEX_APP_SERVER_WRITABLE_VERSIONS`, currently `["0.147.0"]` (`codex-app-server.ts:24`). **[src]**

**So write authority is release-pinned by exact version string, in a gate entirely independent of the evidence ladder.** A passing write probe changes nothing at all until that second gate learns to accept write-covered evidence on a same-major build. This is the real blast radius of emb-49, it is the part that needs founder eyes, and it is why the implementation is not a size 2.

---

## 8. Interaction with emb-57

Orthogonal in mechanism, **in direct tension in outcome.**

The probe mechanism is version-pattern-agnostic — it runs against whatever the surface reports. But a write probe only ever *matters* for builds that reach `schema_attested`, and `schema_attested` requires `sharesCompatibilityMajor` with a certified entry (`compatibility.ts:106-115`, `:222-231`). **[src]** That population is exactly Codex's untested same-major builds.

**emb-57's promise 3 — "0.x minor bumps are major-equivalent" — deletes that population.** Today Codex 0.147.0 is certified and 0.148.x / 0.149.x land in `schema_attested`: precisely the builds a write probe would rescue. Under emb-57 rule 3, 0.148.0 becomes a *different major*, and the architecture's standing law (`GATEWAY-ARCHITECTURE.md:1057`, "probes never promote across a major") means **no probe, read or write, can ever help it.** emb-49's serviceable population collapses to 0.147.x patch bumps only.

My read for the founder:

- **emb-57 rule 3 is correct on safety** and correct for DeepSeek. Do not weaken it.
- **But landing it without emb-49's authority change makes Embassy strictly more brittle against Codex's observed cadence** — the arch doc records 0.145.0 on a remote host against 0.147.0 locally, i.e. minor bumps in weeks. Post-emb-57, every Codex minor bump means monitor-only until an Embassy release ships. Write attestation is the designed escape hatch from exactly that fence; the two tickets are complements, and shipping emb-57 alone converts a soft fence into a hard one.
- **emb-57's prerelease decision and write coverage should stay independent.** State the rule explicitly: *write coverage can raise a build within its tier's authority; it can never promote across a tier, and never for prerelease or unknown-version evidence.* That keeps the unknown-version branch (`compatibility.ts:77-81`) authoritative and prevents a passing write probe from laundering an `-rc` build into writability.

**Sequencing recommendation:** decide emb-57 rule 3 *first*, since it determines whether emb-49's authority change has anyone to serve — but decide it knowing that emb-49(C) below is the release valve.

---

## 9. Priced implementation shape

**New user-facing concepts: 1** — "write evidence" on the Provider compatibility table. Everything else is internal plumbing.

**Line budget (source only):**

| Area | Lines |
|---|---|
| `compatibility.ts` — optional-probe support, `compatibilityOptionalProbeNames`, `compatibilityCoversWrites()` | ~70 |
| `codex-app-server.ts` — allowlist +3, `probeWrite()`, param construction, notification validation, tool-activity fence, cleanup | ~260 |
| `providers.ts` — probe orchestration, probe-dir create/validate, pin resolution, one-shot guard, never-throw discipline, failure mapping | ~200 |
| `providers.ts` + `server.ts` — **write gate derives from write-covered evidence** rather than the exact version list | ~120 |
| `service.ts` — cache gate, one-shot per generation, quarantine mapping, journal action | ~110 |
| `types.ts` — derived `writesCovered`, activity action, validators | ~60 |
| Dashboard model + render + 3 copy files + app-types | ~120 |
| **Total** | **~940** |

Tests will be comparable or larger — the repo runs ~48.2k test lines against ~46.1k source lines.

**As one ticket that is an 8. Split it three ways:**

- **emb-49A — size 2.** Ladder plumbing only: optional-probe support, `compatibilityCoversWrites()`, derived `writesCovered` on the public snapshot, dashboard copy. No probe, no writes, no allowlist change. ~180 lines. Independently testable and independently correct even if nothing else ever lands.
- **emb-49B — size 5.** The bounded write probe: allowlist additions, disposable-thread lifecycle, model/effort pin with reroute verification, the six isolation assertions, cleanup, never-throw, one-shot, safe codes, rate-limit courtesy check. Records the evidence and **still does not unlock writes.** ~520 lines. Landing B alone gives the founder a real, observable, zero-authority-risk answer: *"Codex 0.148.x passes a real write probe on this machine, and it cost N tokens."*
- **emb-49C — size 3.** The authority change: write gate keys off write-covered evidence instead of the `CODEX_APP_SERVER_WRITABLE_VERSIONS` string list, plus the journal action. ~240 lines. **Founder eyes required.** Should not land until B has produced evidence from a real machine.

Total 2 + 5 + 3 = 10 across three tickets versus 8 as one. The 2-point premium buys a genuine stopping point after B, where the evidence exists and no authority has been granted. Given that C changes a fail-closed write gate, that stopping point is worth more than the premium.

---

## 10. Stated unknowns

1. **Whether `TurnStartParams` carries `model`.** `effort` is confirmed at turn level; `ThreadSettings` carries both model-shaped and effort settings but two of its 13 field names were interned earlier in the string table and could not be recovered positionally. Resolvable by the offline JSON-schema generation Embassy has done before (`GATEWAY-ARCHITECTURE.md:803-853`). The belt-and-braces pin in §6 is designed to be correct either way.
2. **Whether `thread/start` is gated behind an `initialize` capability Embassy does not send.** The connector hard-codes `experimentalApi: true` plus `optOutNotificationMethods`; `ThreadStartParams` has 25 fields including `mockExperimentalField` and `experimentalRawEvents`, which suggests gating exists somewhere.
3. **Whether `thread/archive` or `thread/delete` actually removes the rollout from the user's visible history.** `~/.codex/archived_sessions/` holds 1,302 entries on this machine, which strongly suggests archive *moves* rather than erases. **A probe thread likely leaves a durable artifact either way.** This is a founder decision, not an engineering one: if leaving one archived probe thread per Codex version in the user's history is unacceptable, the probe is not shippable in this shape and the answer reverts to "write authority stays release-pinned."
4. **Whether `model/list` is free.** Almost certainly a local catalog read with no model call, but unverified.
5. **Whether the persisted activity-event validator rejects unknown actions** — determines journal option (i) vs (ii) in §5. I did not read it.
6. **The actual token cost of one minimal-effort Luna turn.** Unmeasured. `thread/tokenUsage/updated` will report it; there is no number today, and the founder should see one before emb-49C.
7. **Whether the Desktop App Server honors a fresh thread's `sandboxPolicy: read_only`,** or overrides it from user config. The arch doc's finding is that policy overrides *persist*, not that they are *honored*. Assertion 4 in §1 (observed tool-activity fence) is what makes this safe regardless — the probe fails rather than trusts.

**One further note the founder may want, from emb-54's incidental finding:** the six design laws — including law 3, on which this entire ticket rests — are still not written down anywhere in the Embassy repo. This report leans on law 3 three times. It would be cheap to capture it in `pm/`.

## PM acceptance ruling (2026-08-16)

Report ACCEPTED. Load-bearing source claims spot-checked verbatim before acceptance
(CODEX_APP_SERVER_WRITABLE_VERSIONS = ["0.147.0"] at codex-app-server.ts:24; exact key-set
attestation validator; writableCertified gate at providers.ts:2947+). Rulings under the founder's
conditional fold-in pre-authorization:

- **emb-58 (49A, size 2) FOLDED into v1.6**: ladder plumbing only — optional-probe support,
  derived writesCovered, dashboard copy. Zero writes, zero authority, downgrade-safe by the
  probe-name design. Dispatches when swe3 frees (token thrift: not worth the agent-team lane).
- **emb-59 (49B, size 5) DRAFTED, HELD for founder**: the probe is well-designed, but the report's
  unknown #3 — a probe thread likely leaves a durable archived artifact in the user's Codex history
  per version — is, in the report's own words, "a founder decision, not an engineering one."
  Folding it overnight would enact a founder-values call unilaterally. Morning question, crisply:
  is one archived probe thread per Codex version in your history acceptable?
- **emb-60 (49C, size 3) DRAFTED, HELD**: the actual authority change (write gate keys off
  write-covered evidence instead of the exact version list). Founder eyes required — per the
  report, per the standing rule, and it should not land until emb-59 produces real-machine
  evidence including measured token cost.
- **emb-57 interaction recorded in that ticket**: its rule 3 deletes emb-49's serviceable
  population unless emb-60 lands; sequencing note appended there. Also adopted from the report:
  write coverage raises authority within a tier, never across tiers, never for prerelease builds.
- Second incidental flag tonight: the six design laws are still written nowhere in the Embassy
  repo. Morning item: run aipm §0 adoption retroactively (pm/BELIEFS.md with Protections + laws).
