---
id: emb-54
title: DeepSeek harness as a third Embassy provider — integration shape
kind: investigation
size: 2
status: landed
release: v1.6
updated: 2026-08-16
---

## Binding

**Why**: DeepSeek released their agent harness (github.com/deepseek-ai/deepseek-harness) and the founder wants to know whether Embassy can integrate it as a third provider, and in what form. Embassy's architecture is provider-shaped (Claude sessions, Codex app-server), and the v1.5 evidence ladder was designed precisely for onboarding unknown providers: read probes earn monitor-only, write attestation earns more.

**Deliverable** — a report, not code:
1. What the harness actually is: process model (daemon / CLI / server), session-and-thread model, control surface (API, socket, files), auth, versioning cadence.
2. Which Embassy provider seams it maps onto (discovery, route establishment, turn start/steer, delivery receipts, journal events) — and where it doesn't fit.
3. The monitor-only-first onboarding path under the evidence ladder: what read probes are possible today, and what a write-attestation probe would look like (ties directly to emb-49's design).
4. Ranked integration shapes with size estimates, and the smallest shippable slice (expected: monitor-only visibility first; write authority later, never without founder eyes).
5. Open risks: license, API stability, local-vs-cloud split, token/cost model.

**Budgets**: size 2, investigation — read-only against the public repo and Embassy source. A local install is permitted only if cheap and safe; nothing it does may touch the running broker.

**Non-goals**: no integration code; no provider-registry changes; no commitment that integration lands in v1.6 — the report prices that decision.

## Background (hypotheses — re-verify against current code)

The v1.5 compat rearchitecture ("detect, don't predict") should make a third provider mostly additive: providers enter quarantine/monitor-only by default and only earn authority through evidence. If the harness exposes a controllable local surface, the Codex app-server integration is likely the closest template.

---

## Completion report (2026-08-16, opus investigation agent)

# emb-54 — DeepSeek harness as a third Embassy provider

**Status:** investigation complete. Read-only; nothing installed, no files modified, broker untouched.

**What I actually read.** DeepSeek side (all via WebFetch, 2026-08-16): the repo landing page, `README.md`, `docs/architecture.md`, `docs/api-gateway.md`, `docs/capability-seams.md`, `docs/persistence-catalog.md`, `docs/development.md`, `docs/config-catalog.md`, `docs/glossary.md`, `docs/subsystems/session.md`, `docs/subsystems/persistence.md`, `docs/user/guide/python-sdk.md`, GitHub contents listings for `docs/`, `docs/user/`, `docs/user/guide/`, `docs/subsystems/`, the npm registry JSON for `@deepseek-ai/dsh` and `@deepseek-ai/dsh-acp`, and the PyPI page for `deepseek-harness-sdk`. Embassy side: I read `compatibility.ts` and the load-bearing spans of `service.ts` and `providers.ts` directly, on top of a full-repo seam sweep. **`docs/DESIGN.md` does not exist** — the architecture doc is `/Users/yuanpingsong/Desktop/repos/embassy/docs/GATEWAY-ARCHITECTURE.md`.

Facts are marked **[obs]** (read it) or **[inf]** (reasoned) or **[search]** (search snippet only, not fetched from source — weakest tier).

---

## 1. What the harness actually is

**Identity.** `dsh`, npm `@deepseek-ai/dsh`, MIT, ~118k stars / ~11.6k forks / 12,293+ commits on master. Tagline "Everything is a Plugin," built on the **Cordis** plugin framework. **[obs]**

**Process model — three distinct modes, not one.** **[obs]** From `architecture.md` and `development.md`:
- **`web` profile** — browser app served at `http://127.0.0.1:3080` by default (`npx @deepseek-ai/dsh web`). Long-lived local server.
- **`headless` profile** — explicitly "a one-shot runner with **no server at all**"; invoked `dsh --profile headless "summarize this workspace"`.
- **JSON-RPC runtime subprocess** — the SDKs launch a bundled single-file `dsh-jsonrpc-agent` executable and speak **newline-delimited JSON-RPC over stdio**. **[obs** via `python-sdk.md` + PyPI; the TypeScript-SDK equivalent is **[search]** only**]**

There is no evidence of a system daemon, a Unix socket, or a background service that outlives the client. Every mode is client-launched and client-scoped. **[inf]**

**Session/thread model.** Strong, and unusually well-specified. **[obs]** A Session is "an append-only log of typed `SessionEvent`s — the single source of truth." LLM history is *derived* from the log, never stored separately. `SessionHeader` carries an immutable `SessionId` (auto-minted `session-<n>`), format version, creation time, parent-session lineage for forks, and an absolute working directory. `SESSION_FORMAT_VERSION = 0`, documented as "pre-release, no compatibility implied."

Turn/step hierarchy maps almost exactly onto Embassy's vocabulary: `turn/start`/`turn/end` enclose one model-loop execution; `TurnEndReason` ∈ {completed, aborted, blocked, error, max-tokens, interrupted}; `step/start`/`step/end` nest inside. **One turn at a time is enforced.** Cancellation is a typed `AgentCancelCause` producing `turn/end` with reason `aborted`, held distinct from error. There is no documented *steer-while-busy* primitive — only cancel. **[obs]**

**Control surface — the important nuance.** Three surfaces exist and they are not interchangeable:
- `docs/api-gateway.md` describes an **internal** RPC framework, not a public API. Endpoints are `POST /api/<namespace>/<method>` carrying an `args` object, reached through a Cordis `Connection`. The doc states plainly it is **"not designed for external/unauthenticated access — it's an internal service-to-service RPC framework,"** requires build-time generated client declarations, and explicitly excludes streaming from `Remote`. **[obs]** This is *not* a viable Embassy integration surface.
- **`@deepseek-ai/dsh-acp`** — "Automation-only Agent Client Protocol server for driving DeepSeek Harness agents over JSON-RPC stdio," depending on `@agentclientprotocol/sdk` 0.25.1. **[obs** from npm**]** This is a standards-track surface (ACP, the Zed-originated protocol).
- **The SDK JSON-RPC stdio protocol** — `dsh-jsonrpc-agent`, driven by `HarnessClient` (low-level) and `DeepSeekHarness`/`Session.run()` (high-level), with `RunResult{session_id, final_response, finish_reason, events, notifications, session_root}` and an `on_notification` stream carrying root plus descendant-subagent events in wire order. **[obs** for Python**]**

**Auth.** `DEEPSEEK_API_KEY` (env or gitignored `.env`), optional `DEEPSEEK_BASE_URL`. Credentials also persist to `.credentials.yaml` under the Harness home via the `credentials-local` plugin, and there is a `ctx.credentials` capability seam. **[obs]** I found **no documented authentication on the local web server or on the stdio JSON-RPC surface** — stdio is parent-process-scoped, and the web server binds 127.0.0.1. **[obs, absence]**

**On-disk state.** Harness home `~/.dsh`, override `$DSH_HOME`; also `$DSH_AGENTS_HOME` (default `~/.agents`), `$DSH_SESSION_ROOT`, `$DSH_CORDIS_CONFIG`. Config is layered `cordis.patch.yml` at profile/home/overlay levels, plus `settings.yaml` and `.credentials.yaml`. Session persistence is a swappable seam (`ctx.sessionPersistence`: `jsonl` | `sqlite`); the JSONL backend is "an append-only logical JSONL log per session, stored as **checksummed concatenated Zstandard frames by default** or raw lines by configuration." SQLite uses `node:sqlite`, one row per `SessionEvent`. Listing is `list()` → `SessionHeader[]` and `listSnapshots()` → revision tokens. **[obs]**

**Versioning cadence — the headline risk.** **[obs]** npm `@deepseek-ai/dsh`: first publish `0.0.1-rc.1` on **2026-08-10**; latest `0.1.0-rc.6` on **2026-08-13**. Six published versions in four days. The package is **six days old today.** `README.md` states: *"currently in developer preview and is iterating rapidly. **THERE WILL BE COMPATIBILITY-BREAKING CHANGES.**"* `capability-seams.md` documents no semver scheme. `dsh-acp` **changed license from BSD-3-Clause to MIT between `0.0.1-rc.5` and `0.1.0-rc.2`.**

---

## 2. Seam mapping onto Embassy

Embassy is TypeScript/Node ≥20, ESM, `agent-embassy` v1.5.0, `"os": ["darwin"]`, ~46.1k source lines under `src/gateway/` against ~48.2k test lines. The stack matches DeepSeek's exactly — a Node-side ndjson JSON-RPC client is idiomatic here, and `codex-local-transport.ts` (1,014 lines) is a working template.

The provider contract is `GatewayProviderAdapter` at `/Users/yuanpingsong/Desktop/repos/embassy/src/gateway/service.ts:316` — a structural TS interface, 8 strictly-required members plus 2 de-facto required (`compatibilitySurface()`, `runCompatibilityProbes()`; boot throws `COMPAT_PROVIDER_UNAVAILABLE` without them, verified at `service.ts:1255-1263`). `LocalCodexGatewayProvider` implements 10; `LocalClaudeGatewayProvider` implements 32. **A monitor-only third provider targets the Codex shape.**

| Embassy seam | DeepSeek fit | Verdict |
|---|---|---|
| **Compatibility surface + probes** (`compatibility.ts`) | `dsh --version`, `~/.dsh` presence, spawn `dsh-jsonrpc-agent`, `session list()` | **Best fit.** Direct analogue of Codex's `installation`/`control_socket`/`initialize`/`thread_list`. |
| **Turn start** (`dispatchOne`, `service.ts:6810`) | `Session.run()` / ACP prompt over stdio | Good fit — one turn at a time on both sides. |
| **Route state idle/busy** | Session tracks whether a turn is open | Good fit. |
| **Steer-while-busy** | No steer primitive found; only typed cancel | **Gap.** Codex-only by construction anyway (`service.ts:6824`, `6899`); DeepSeek falls through to `routeState === "idle"` — safe, but no steer. |
| **Discovery** (`discoverClaudePeers?`) | No registry of running harnesses; sessions are client-launched | **Gap.** Like Codex, DeepSeek would self-register, not be discovered. |
| **Delivery receipts** (`delivery-machine.ts`, 942 lines, 0 provider refs) | `RunResult.finish_reason`, `TurnEndReason`, `on_notification` | **Clean fit — no changes.** The 21-variant `DeliveryEvent` union is fully provider-generic. |
| **Route establishment / pairing** | — | **Hard blocker.** `PairParams {claudeAlias, codexAlias, codexThreadId?}` (`control.ts:128`) is a typed Claude×Codex product. |
| **Message direction** | — | **Hard blocker.** `messageDirections = ["codex_to_claude","claude_to_codex"]` (`types.ts:59`), a closed 2-provider product baked into `NormalizedMessageEvent`, persisted state, and dashboard filters. |
| **Journal events** | — | 7 of 11 `gatewayActivityActions` (`types.ts:509`) are provider-hardcoded. |
| **Provenance envelope** | — | `ProvenanceEnvelopeDirection = "codex" \| "claude"` (`provenance-envelope.ts:17`) needs a third direction. |

**Where the ticket's hypothesis holds and where it breaks.** "A third provider should be mostly additive" is **true for the monitor-only slice and false beyond it.** Monitor-only touches compatibility, detection, and dashboard — all genuinely additive. The moment DeepSeek needs to *route* a message, it hits three closed product types (`PairParams`, `messageDirections`, `ProvenanceEnvelopeDirection`) that were designed as 2-provider and do not generalize by widening a union.

**The single highest-risk edit** is `service.ts:1268-1276`, which I read directly:

```ts
if (bySurface.size !== compatibilitySurfaces.length ||
    compatibilitySurfaces.some((surface) => !bySurface.has(surface))) {
  throw new BridgeError("COMPAT_PROVIDER_UNAVAILABLE",
    "The bounded compatibility probe requires one Claude and one Codex surface.");
}
```

Boot **fails closed on exact arity**. Adding `deepseek` to `compatibilitySurfaces` makes a DeepSeek adapter **mandatory at boot on every install**, including the overwhelming majority that will never have `dsh`. This must be relaxed to tolerate optional/absent surfaces *before* any third surface is declared.

**Hidden-cost warning:** `service.ts:2068`, `:2076`, `:2083` annotate provider as hand-written `"codex" | "claude"` literals rather than the `GatewayProvider` alias, so **widening the union produces no compiler error at those sites**. Same trap in `compatibility.ts`: `legacyVersionDriftCode` (`:67`) and `unsupportedVersionCode` (`:89`) are `surface === "claude" ? A : B` **ternaries** — a third surface silently receives the *Codex* error code. There are ~150 discriminating branches overall (67 in `service.ts`, 55 in `store.ts`, 14 in `dashboard-model.ts`); most fall through safely for a non-routing provider, but they are not compiler-checked.

---

## 3. Monitor-only onboarding under the evidence ladder

**The ladder, verified in source** (`/Users/yuanpingsong/Desktop/repos/embassy/src/gateway/compatibility.ts`, 347 lines). Tiers are exactly three: `certified`, `schema_attested`, `incompatible` (`:15`). Promotion logic at `evaluateCompatibilityAttestation` (`:181`, rules at `:216-231`): any probe fail → `incompatible`; else exact version in certified set → `certified`; else shares major with a certified version → `schema_attested`; else → `incompatible`. Per `GATEWAY-ARCHITECTURE.md:1049`, `schema_attested` is writable *only where probes cover writes* — Codex's four probes are all reads, so Codex is pinned monitor-only via the literal quarantine code `CODEX_MONITOR_ONLY` (`service.ts:1311-1319`).

### The blocking finding: DeepSeek cannot rise above `incompatible` today

`compatibility.ts:62`:

```ts
const VERSION_PATTERN = /^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}$/;
```

Strict three-part numeric — **no prerelease suffix**. Every DeepSeek version ever published is a prerelease (`0.1.0-rc.6`, `0.0.1-rc.1`, …). Consequences, all traced through the code:

1. `isCompatibilityVersion("0.1.0-rc.6")` → false, so the adapter **must** report `UNKNOWN_COMPATIBILITY_VERSION` or `evaluateCompatibilityAttestation` throws `COMPAT_VERSION_INVALID` (`:198`).
2. `unsupportedVersionCode` with `"unknown"` returns a `*_VERSION_UNPARSEABLE` code (`:77-81`) → **tier = `incompatible`, unconditionally.**
3. You cannot escape by pinning a certified version: `certifiedVersions` entries are themselves `VERSION_PATTERN`-checked (`:208`), so `"0.1.0-rc.6"` throws `COMPAT_CERTIFIED_SET_INVALID`. And the inventory **must be nonempty** (`:207`) — you cannot add a surface with no certified builds at all.

**This is good news for the smallest slice and bad news for the roadmap.** Monitor-only comes *free and correct* — the ladder naturally classifies DeepSeek as quarantined with zero new tier logic, and `IncompatibleGatewayProvider` (`providers.ts:454-585`, 132 lines, which I read in full) is the exact template: it satisfies the interface, returns `{health: "degraded", compatibility: "incompatible"}` from `initialize`, and throws `this.unavailable()` from `selectRoute` and `dispatch`. But "earning authority through probes" is **structurally unreachable** until either DeepSeek ships a stable `X.Y.Z` or Embassy extends `VERSION_PATTERN` to parse prereleases.

Related latent issue worth a separate ticket: `versionMajor` (`:94`) makes all `0.x` builds share major `0`. Under semver, `0.x` minor bumps are breaking. Codex at `0.147.0` already sits in this trap; DeepSeek at `0.1.0` would inherit it.

### Read probes possible today (the proposed `deepseek` probe set)

Mirroring Codex's four, all bounded and side-effect-free:

| Probe | Mechanism | Confidence |
|---|---|---|
| `installation` | `dsh` resolvable on PATH, or `~/.dsh` / `$DSH_HOME` exists | High — `config-catalog.md` **[obs]** |
| `harness_home` | `~/.dsh` readable; `settings.yaml` parses | High **[obs]** |
| `runtime_launch` | spawn `dsh-jsonrpc-agent` with a deadline, observe handshake, kill | Medium — launch mechanism **[obs]**, handshake method name **unverified** |
| `session_list` | JSON-RPC equivalent of `SessionPersistence.list()` → `SessionHeader[]` | Medium — the method exists as a service **[obs]**; its *wire name* is **unknown** |

A pure-filesystem variant of the last two is available and cheaper: enumerate session directories under the harness home. But note `persistence.md` **[obs]** — the JSONL backend defaults to **checksummed concatenated Zstandard frames**, not raw lines, so file-tailing requires zstd framing support. Raw lines are config-only. That materially raises the cost of a filesystem-only read path and argues for the JSON-RPC path instead.

A `version` probe is possible but, per the finding above, **is guaranteed to fail** while `-rc` versioning holds. That is arguably correct behavior — the evidence honestly says "unknown build."

### What a write-attestation probe would look like (ties to emb-49)

emb-49 ("Codex write-attestation probe — design pass," size 2, v1.6, draft) cites **"design law 3: evidence must cover the authority it grants"** — read probes can never earn `turn/start`. (Note: I searched `AGENTS.md`, all of `docs/`, and `CHANGELOG.md` — **the numbered design laws are not written down in the Embassy repo.** They live outside it. Worth capturing.)

A DeepSeek write attestation would follow emb-49's Codex shape closely, and the harness is unusually friendly to it:
- Create a **throwaway session** in a temp `$DSH_SESSION_ROOT` — sessions carry their own absolute working directory in the header, so isolation is native.
- Run one minimal turn with the cheapest model at lowest effort (emb-49's constraint), asserting observation of `turn/start` → `step/start` → `step/end` → `turn/end{reason: "completed"}`.
- Assert `finish_reason` and that no tool executed — set `ctx.approval`/`ctx.sandbox` seams to deny, since both are swappable capability seams **[obs]**.
- Fail safe, no retry storm.

**A real advantage over Codex here:** DeepSeek's write path is *observable in the event log* rather than inferred. `turn/end` carries a typed `TurnEndReason` distinguishing completed / aborted / error / max-tokens, and cancellation is explicitly "distinct from error." That is exactly the evidence quality a write attestation needs. **[obs, inference on the fit]**

**The cost:** every write probe spends real DeepSeek API tokens against the user's `DEEPSEEK_API_KEY`, on every boot the attestation cache misses. Given six version bumps in four days, cache misses would be near-constant.

---

## 4. Ranked integration shapes

**Shape A — Attestation-only visibility (RECOMMENDED smallest slice).**
DeepSeek becomes a *compatibility surface* that appears on the dashboard as detected-and-quarantined. It is never added to `gatewayProviders`, never routes, never pairs. Crucially, `compatibilitySurfaces` (`compatibility.ts:3`) is a **separate constant** from `gatewayProviders` (`types.ts:12`) — that separation is the seam that makes this cheap, and it avoids all three closed product types entirely. Delivers the real user value ("Embassy sees my DeepSeek harness") at the lowest blast radius. Requires decoupling `IncompatibleGatewayProvider`'s surface from `identity.provider`, which currently couples them at `providers.ts:467`.

**Shape B — Monitor-only routable provider.** Full `LocalCodexGatewayProvider`-shaped adapter over stdio JSON-RPC, registered as a provider, write-fenced by quarantine. Adds `gatewayProviders`, `PairParams`, `messageDirections`, journal actions, provenance direction. This is where the 2-provider product types bite. Est. **8**, and I'd want a design pass before pricing it firmly.

**Shape C — ACP-mediated provider.** Integrate via `@deepseek-ai/dsh-acp` and the ACP standard rather than DeepSeek's own SDK protocol. Strategically the strongest: ACP is a versioned third-party standard (`@agentclientprotocol/sdk` 0.25.1), so Embassy would insulate itself from DeepSeek's rc churn and open a path to *any* ACP agent as a fourth, fifth provider. But `dsh-acp` is itself six days old and just changed license. **Recommend revisiting after v1.6**; this is the best long-term bet and the wrong short-term one.

**Shape D — Write authority.** Blocked on emb-49 landing, on the `VERSION_PATTERN` fix, and on founder eyes. Not v1.6.

### Smallest shippable slice and size

**Slice:** Shape A — Embassy detects a local DeepSeek harness, runs bounded read probes, records an `incompatible`/quarantined attestation, and renders it on the dashboard. No routing, no writes, no pairing.

**Size: 5** (source lines only; rungs 1/2/3/5/8).

Line budget: new `deepseek-detect.ts` probe module ~200; `compatibility.ts` surface/probe/certified additions plus converting two ternaries to exhaustive switches ~40; `IncompatibleGatewayProvider` surface/provider decoupling + factory ~60; `server.ts` dependency hooks and construction ~90; the `service.ts:1268` boot-arity relaxation ~40 (small but invariant-changing); `assertCrossProviderMutationCompatible` fence ~10; dashboard model + copy across five locale files ~130. Roughly **550-650 source lines**, with risk concentrated in the boot gate rather than the volume.

**PM recommendation — split it.** The boot-arity relaxation is a fail-closed invariant change that deserves its own ticket with its own tests, independent of DeepSeek. Split as: (i) "make the compatibility surface set tolerant of optional/absent surfaces" — **3**; then (ii) "DeepSeek monitor-only attestation" — **3**. Two 3s land more safely than one 5, and (i) has standalone value for every future provider.

---

## 5. Open risks

**API stability — severe, and the dominant risk.** Six npm versions in four days; the package is six days old; the README shouts that breaking changes *will* happen; `SESSION_FORMAT_VERSION = 0` with "pre-release, no compatibility implied"; `capability-seams.md` documents no semver policy. Any probe set written this week should be assumed stale within weeks. **This is the single strongest argument for shipping only Shape A** — a quarantined attestation that degrades gracefully to "detected, unattested" costs nothing when the upstream shape moves.

**License — small but real.** `@deepseek-ai/dsh` is MIT. But `@deepseek-ai/dsh-acp` **shipped BSD-3-Clause for `0.0.1-rc.*` and MIT from `0.1.0-rc.2`**. A license changing mid-prerelease is a governance smell; if Shape C is ever pursued, re-verify. `THIRD_PARTY_NOTICES.md` and a `vendor/` directory with manifest tracking exist — unreviewed by me.

**Local-vs-cloud split — the sharpest philosophical mismatch.** Embassy's existing providers are local processes the user already runs and pays for out-of-band. DeepSeek Harness is a local process that **calls a remote paid API on every turn** via `DEEPSEEK_API_KEY`. Embassy would, for the first time, be brokering messages into a surface that bills per token. Read probes are free; **write probes are not**, and emb-49's design must account for a provider whose attestation has a dollar cost. `DEEPSEEK_BASE_URL` allows self-hosted/proxy endpoints, so cost is not universal — but it is the default.

**Token/cost model — unquantified.** I found no pricing or token-accounting detail in the harness docs. `ctx.sessionTelemetry` exists as a capability seam **[obs]** but I did not read `docs/subsystems/session-telemetry.md`. If write attestation is ever pursued, that doc is required reading.

**Credential blast radius.** `.credentials.yaml` under `~/.dsh` plus a `ctx.credentials` seam means a DeepSeek adapter operates near a plaintext-ish credential store. Embassy's read probes must never read, log, or echo that file. Worth an explicit non-goal in any implementation ticket.

**Platform.** Embassy is `"os": ["darwin"]`. DeepSeek ships platform-specific `deepseek-harness-runtime-bin` wheels and a `pwsh` shell backend, so it is cross-platform — no conflict, but the Embassy-side probe only needs darwin paths.

---

## Stated gaps (not guessed)

1. **The JSON-RPC wire method names are unverified.** I confirmed the transport (ndjson JSON-RPC over stdio), the client classes, and the service-level operations (`list()`, `listSnapshots()`, `load(id)`, `Session.run()`, `session_prompt()`), but **not the on-the-wire method strings**. Probe design in §3 is therefore shaped correctly but not yet callable. Resolving this needs the source of `dsh-jsonrpc-agent` or `packages/` — one focused follow-up fetch.
2. **The TypeScript SDK is `[search]`-only.** Its existence, package name, and `HarnessClient` API came from search snippets, not a doc I fetched. Since Embassy is TypeScript, this is the highest-value gap to close and I'd verify it before committing to Shape B.
3. **`docs/user/guide/web-ui.md` returned 404** at the path the README links. The web-UI flags (port, host binding, any auth token) are consequently unverified; I did not find evidence of local-server auth either way.
4. **Session-id format is undocumented** beyond the auto-minted `session-<n>` fallback.
5. **I did not read** `docs/subsystems/session-telemetry.md`, `session-query.md`, `session-projection.md`, `credentials.md`, or `invariants.md`. `invariants.md` in particular may bear on probe safety.
6. **No local install was performed** — permitted by the ticket but not necessary for the deliverable, and it would have cost an API key and real tokens.

## PM acceptance ruling (2026-08-16)

Report ACCEPTED. Both load-bearing code claims spot-checked against source before acceptance
(VERSION_PATTERN at compatibility.ts:62; boot-arity throw at service.ts:1274 — both verbatim).
Rulings:
- Shape A (attestation-only visibility) is the right first slice; the report's split adopted as
  drafts emb-55 (boot-arity tolerance, size 3) + emb-56 (DeepSeek monitor-only attestation, size 3).
  NOT dispatched overnight: the founder's overnight bar was a monitor-only slice at size <=3 total;
  3+3 exceeds it. Founder triages in the morning.
- emb-57 drafted (size 2): prerelease + 0.x version semantics — blocks any DeepSeek tier above
  incompatible; also latent for Codex 0.x.
- Shapes B/C/D DECLINED for v1.6: B hits three closed 2-provider product types; C (dsh-acp/ACP)
  is the best long-term bet but the package is six days old with a mid-prerelease license change —
  revisit after v1.6; D (write authority) waits on emb-49 + founder eyes.
- Incidental finding logged: the six design laws are not written anywhere in the Embassy repo —
  candidate pm/ content, founder's call.

## Corrections (2026-08-16, from the emb-61 transport investigation — registry-verified)

Two claims in the completion report above are corrected by deeper evidence: (1) dsh-acp's npm
`latest` dist-tag points at 0.0.1-rc.1 (BSD-3-Clause, day-one build) — the MIT 0.1.0-rc line sits
under `next`, so a default install gets the oldest build under the older license; (2) the native
SDK **wire** has no cancel method — the typed AgentCancelCause exists only in-process. Also closed:
the TypeScript SDK is real (read from source), and native wire method names are now verified
(requests use slash: session/prompt; notifications use dot: session.event). See emb-61.
