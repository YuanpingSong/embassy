---
id: emb-61
title: Routable DeepSeek provider — transport decision + product-type generalization (design)
kind: investigation
size: 3
status: review
release: v1.7
updated: 2026-08-16
---

## Binding

**Why**: founder has ruled full DeepSeek integration into v1.7 ("the fundamental interfaces are
fairly settled... fine as long as there are protocols"). Two design questions gate implementation:

1. **Transport**: ACP (`@deepseek-ai/dsh-acp`, open standard, founder-attractive) vs the SDK's
   native JSON-RPC stdio protocol. Founder delegated this call to the PM on technical maturity;
   the open question is whether ACP exposes the full feature set Embassy needs (turn start,
   interrupt/steer-equivalent, session enumeration, event stream with correlation ids, model and
   effort control) or a subset. A feature-coverage investigation feeds this ticket.
2. **Product-type generalization**: `PairParams` (claude×codex product), `messageDirections`
   (closed 2-provider union), and `ProvenanceEnvelopeDirection` must generalize to N providers.
   **Provenance is a named pillar of the founder's trust model — this design requires founder
   eyes before any implementation dispatch, regardless of schedule.**

**Deliverable**: transport recommendation with feature matrix and maturity evidence; the
generalization design for the three closed types with downgrade-safety analysis (design law 2);
a priced implementation split. No code.

**Non-goals**: no implementation; no provenance changes ship without founder review of this design.

---

## Transport investigation report (2026-08-16, opus agent)

# emb-61 — ACP vs native JSON-RPC as the DeepSeek transport for Embassy

**Note before the report:** `/Users/yuanpingsong/Desktop/repos/embassy/pm/tickets/emb-61.md` **does not exist.** The tickets directory holds emb-49, 52, 53, 54, 55, 56, 57, 58, 59, 60 and `tracker.md`. I proceeded from the task brief and emb-54's completion report. If emb-61 was drafted elsewhere, this report may not match its binding.

**Marking:** **[src]** = I downloaded the file and read/grepped it myself (strongest); **[obs]** = fetched a doc, read via summarizer; **[reg]** = queried the npm/GitHub registry API directly; **[inf]** = reasoned; **[search]** = search snippet only, unverified (weakest).

**What I read.** ACP: `agentclientprotocol.com` llms.txt index, `protocol/v1/{overview,initialization,prompt-turn,session-list,session-config-options,cancellation,extensibility,transports,schema}`, `get-started/{agents,registry}`, `community/governance`, `rfds/about`, `announcements/{acp-v2-draft,sdk-1-0-releases}`. DeepSeek: **downloaded and read in full** `packages/acp/acp/src/index.ts` (436 lines) and `codec.ts`, and `packages/sdk/protocol/src/types.ts` and `packages/sdk/client/src/api.ts`; plus `packages/acp/acp/{README.md,package.json}`, root `package.json`, `examples/jsonrpc-agent/README.md`, a native notification snapshot fixture, `docs/config-catalog.md`, `docs/user/guide/python-sdk.md`. Registry: npm JSON for `@deepseek-ai/{dsh,dsh-acp,dsh-subagent-acp}`, `dsh-plugin-acp`, `@agentclientprotocol/sdk`; GitHub commit history for `packages/acp` and `packages/sdk`.

---

## Headline

**The ACP surface exposes a strict and deliberately narrow subset — but the subset is drawn by DeepSeek's adapter, not by ACP.** ACP-the-standard covers six of Embassy's seven requirements. `@deepseek-ai/dsh-acp` implements **five JSON-RPC handlers total** and covers two.

And the comparison does not resolve cleanly in either direction, because **the two surfaces are absent in complementary places**: ACP has interrupt and native does not; native has turn-lifecycle events and event-stream fidelity and ACP-via-dsh-acp deliberately strips them. Neither has session enumeration.

Separately: **`@deepseek-ai/dsh-acp` cannot be spawned.** No published version has a `bin`; it is a Cordis plugin with five workspace peer dependencies, and the only documented launch path runs an *example* from a repo checkout. That is a packaging blocker independent of every feature question.

---

## 1. Feature matrix

Three columns, because collapsing "ACP" into one hides the whole finding.

| Embassy requirement | ACP v1 spec | `@deepseek-ai/dsh-acp` as implemented | Native SDK JSON-RPC |
|---|---|---|---|
| **Start a turn with a text message** | **Supported** — `session/prompt`, `ContentBlock[]` **[obs]** | **Supported (lossy)** — text + `resource_link` only; blocks are **flattened and concatenated into one string**; image/audio/embedded rejected with `only text and resource_link prompt content is supported`; one in-flight prompt per session enforced **[src]** | **Supported (richer)** — `session/prompt {sessionId, contentBlocks}` → `{messageId}`; blocks "sent verbatim as the user message"; unknown `sessionId` lazily creates the agent+session pair **[src]** |
| **Correlated turn lifecycle (started/completed with ids)** | **Partial** — turn = the request/response pair; correlation via JSON-RPC id + `sessionId`; `stopReason` on response; opaque `messageId` on chunks. No turn-start event, no turn id **[obs]** | **Absent-in-effect** — response carries `{stopReason}` only. It *does* correlate a turn number internally (`inflight.turn`) but **never puts it on the wire**. Worse, settlement awaits `agent.whenIdle()`, not the correlated `turn/end`; source comment: *"Other producers may run further turns before quiescence; the prompt settles only when the agent stops."* **[src]** | **Supported, best-in-class** — `session.event` streams `turn/start{turn:N}`, `step/start{turn,step}`, `step/end`, `turn/end{turn,reason}`, each with monotonic `seq` + `time`; plus `session.status: idle\|running` **[src]** |
| **Interrupt a running turn** | **Supported** — `session/cancel` notification; agents MUST return `cancelled` **[obs]** | **Supported** — `cancel()` → `agent.cancel({kind:'user'})` + settles `'cancelled'` **[src]** | **ABSENT** — the wire has exactly three request methods: `initialize`, `session/prompt`, `shutdown`. A grep for `cancel\|interrupt\|abort` across the client API returned **zero hits**. Only escapes are whole-process `shutdown` or killing the subprocess **[src]** |
| **Enumerate existing sessions** | **Supported** — `session/list` (stabilized), `cwd` filter, cursor pagination, `SessionInfo{sessionId,cwd,title,updatedAt}`, gated on `sessionCapabilities.list` **[obs]** | **ABSENT** — README: *"Fresh sessions only — load, list, resume, delete, and fork are unsupported."* Source confirms no such handler. It correctly does **not** advertise the capability, so absence is cleanly discoverable **[src]** | **ABSENT on the wire** — `SessionPersistence.list()` is in-process only. Client chooses session ids; unknown ids create. Addressable, not discoverable **[src]** |
| **Event / notification stream** | **Supported** — `session/update` with many variants (message chunks, thought chunks, tool_call, tool_call_update, plan, mode/config updates, usage) **[obs]** | **Severely partial** — **only `agent_message_chunk`**, only committed assistant text (image blocks become the literal text `[image attachment <id>]`). Source comment: *"Emit only committed assistant text. Raw chunks, reasoning, tools, plans, titles, and retry markers are presentation or trace data and stay off the automation wire."* **[src]** | **Supported, full** — `session.event` carries the entire `SessionEvent` log verbatim, and explicitly *"every session in the runtime, not only SDK-created ones"* — reasoning deltas, `request/header` (the provider+model actually dispatched), titles, tool events. Plus `subagent.started` / `subagent.finished` **[src]** |
| **Model selection + reasoning effort, per turn** | **Partial** — `session/set_config_option` with reserved categories `model`, `model_config`, `thought_level`; but spec states config is **session-level, explicitly not per-turn** **[obs]** | **ABSENT** — no `set_config_option`, no `set_mode` handler. `provider`/`model` come from the **Cordis plugin config** (`AcpConfig`), fixed at plugin-apply time, applied identically to every `newSession`. **The ACP client cannot influence the model at all.** No reasoning/effort/thought concept anywhere in the source **[src]** | **Partial** — `initialize{cwd, provider, model, maxTokens}` is client-chosen but **process-wide**. `RunOptions` carries only `sessionId` and `onNotification`. Reasoning effort is a YAML plugin-config concern, not on the wire **[src]** |
| **Version / capability handshake** | **Supported** — `initialize` with MUST-level `protocolVersion` negotiation, `clientCapabilities`/`agentCapabilities`, `agentInfo{name,title,version}`, `authMethods`; every optional method capability-gated **[obs]** | **Partial, and broken for Embassy's purpose** — returns the SDK's `PROTOCOL_VERSION` unconditionally (*"Single-version agent"*) and `agentInfo: { name: 'deepseek-harness-acp', version: '0.0.1' }` — a **hardcoded `'0.0.1'` that does not track the package version** (`0.1.0-rc.6`). Capability flags are honest. `authenticate()` is a no-op returning void **[src]** | **Partial, mirror-image** — `initialize` → `{serverInfo:{name, version}}`, a real version, with an explicit stability commitment in-source: *"`serverInfo.name` stays the wire-stable `deepseek-harness-sdk-runtime`."* But **no capability negotiation and no protocol version at all** **[src]** |

**Tally.** dsh-acp: 2 supported (one lossy), 2 partial, 3 absent. Native: 3 supported, 2 partial, 2 absent. ACP spec: 5 supported, 2 partial, 0 absent.

**Nothing is "unknown."** Every cell above is settled from source or spec. The one thing I could not verify is behavioral (see Gaps).

---

## 2. The finding that should drive the decision: dsh-acp destroys turn-outcome evidence

`packages/acp/acp/src/codec.ts`, `turnEndToStopReason` **[src]**:

```ts
case 'completed':   return 'end_turn'
case 'max-tokens':  return 'max_tokens'
case 'aborted':     return 'end_turn'
case 'interrupted': return 'cancelled'
case 'blocked':
case 'error':       return 'end_turn'
```

…and `index.ts:331` then overrides the one informative case:

```ts
inflight.resolve(end.kind === 'max-tokens' ? 'end_turn' : turnEndToStopReason(end))
```

So over the ACP wire, DeepSeek's 6-variant `TurnEndReason` collapses to:

- **`end_turn`** ← `completed`, `max-tokens`, `aborted`, `blocked` — four distinct outcomes, **three of them not success**, all reported identically
- **`cancelled`** ← `interrupted`, explicit `session/cancel`, **and the turnless case** (`if (end === undefined) inflight.resolve('cancelled')`)
- **JSON-RPC internalError** ← `error` (rejected out-of-band before reaching the mapping)

emb-54 §3 argued that DeepSeek's typed `TurnEndReason` was *"exactly the evidence quality a write attestation needs"* and *"a real advantage over Codex."* **That advantage is real on the native protocol and is annihilated by dsh-acp.** A policy-blocked turn and a token-truncated turn both report success.

Compounding it: because settlement waits for whole-agent idle rather than the correlated `turn/end`, a `session/prompt` response can arrive arbitrarily late relative to its own turn and can carry a *different* turn's outcome. **Embassy's turn correlation over dsh-acp would be unsound**, not merely coarse.

For a provider whose entire v1.6 slice is *monitor-only* — i.e. observation — the surface that refuses to be observed is the wrong surface.

---

## 3. The packaging blocker

Verified three ways **[reg][src][obs]**:

- **No `bin` in any of the six published versions** of `@deepseek-ai/dsh-acp`. Same for `@deepseek-ai/dsh-subagent-acp`. By contrast `@deepseek-ai/dsh` does ship `bin: {dsh: "lib/bin.js"}`.
- Peer dependencies: `@deepseek-ai/cordis`, `dsh-agent`, `dsh-session`, `dsh-invariants`, `dsh-user-approval`. It exports `apply(ctx: Context, config: AcpConfig)` — a **Cordis plugin**, not a server.
- The README's only launch instruction is `pnpm --dir /path/to/deepseek-harness run demo:acp`, which the root `package.json` resolves to:
  `node --import tsx packages/examples/acp-demo/src/bin.ts --config examples/acp-agent/cordis.yml`
  — an **example**, run from a **repo checkout**, via `tsx`.

There is no `npx` path and no supported standalone artifact. An Embassy `runtime_launch` probe has nothing to spawn. The native side, by contrast, ships a real single-file bundled executable via PyPI (`deepseek-harness-runtime-bin`), and the jsonrpc-agent README states *"the target machine does not need Node.js."*

A search snippet described `dsh-plugin-acp` as *"an ACP profile plugin and standalone stdio server… sharing DSH credentials and sessions"* **[search]**. **I checked npm and this is false** **[reg]**: `dsh-plugin-acp` is a third-party policy-enforcement plugin from `agentic-control-plane`, one version, no `bin`, no dependencies, unrelated to serving ACP. Discard that claim; it appears to be third-party SEO copy.

---

## 4. Maturity comparison

### ACP the standard — materially more mature than emb-54 credited

| Axis | Evidence |
|---|---|
| **Spec stability** | v1 stable. Formal RFD process, six statuses, with explicit 1-way-door semantics: *"Completed is the only state that can represent a 1-way door (if there is a stability commitment involved)."* ~20 features carry individual "stabilized" announcements **[obs]** |
| **Versioning** | Integer `protocolVersion` with MUST-level negotiation; every optional method gated behind a declared capability — a client discovers a subset rather than probing for it **[obs]** |
| **Extension mechanism** | `_meta: {[key:string]: unknown}` on **every** protocol type, plus underscore-prefixed custom methods, with defined unknown-handling (respond method-not-found to unknown requests; ignore unknown notifications). Reserved W3C trace-context keys **[obs]** |
| **v2 churn risk** | v2 published **as a Draft on 2026-07-20**, explicitly *"avoid production deployment until closer to stabilization."* Crucially: *"v1-only peers will remain common for some time, so implementers should support both versions side by side."* **No v1 deprecation timeline.** Breaking changes are real (prompt-lifecycle overhaul, ID-based message patching, diff restructuring) but v1 is not being pulled **[obs]** |
| **Governance** | Jointly governed by **Zed and JetBrains**; lead maintainers Ben Brandt (Zed) and Sergey Ignatov (JetBrains) with veto; explicit intent to move to an independent foundation **[obs]** |
| **Adoption** | ~38 agents named on the agents page; registry claims 50+ **[obs]** |
| **SDK churn** | `@agentclientprotocol/sdk`: 49 versions since 2025-10-10; **1.0.0 on 2026-06-24**; latest **1.3.0 on 2026-07-21** — and **no publish in ~4 weeks**. Cadence visibly slowed post-1.0. Apache-2.0. Repo now `agentclientprotocol/typescript-sdk`, its own org **[reg]** |
| **Transport fit** | stdio is normative (SHOULD-level), newline-delimited JSON-RPC, no embedded newlines, UTF-8. **Identical framing to Embassy's existing Codex transport.** Streamable HTTP is draft-only **[obs]** |

### dsh-acp the adapter — weak, and weak in ways emb-54 partly mis-stated

| Axis | Evidence |
|---|---|
| **Release hygiene** | **`dist-tags.latest` = `0.0.1-rc.1`** — the day-one publish, **BSD-3-Clause**. The MIT `0.1.0-rc.*` line sits under the `next` tag. A plain `npm i @deepseek-ai/dsh-acp` **gets the oldest build under the older license.** Same inverted tagging on `dsh-subagent-acp`; `@deepseek-ai/dsh` itself is tagged correctly. **[reg]** |
| **Upstream lag** | Pins `@agentclientprotocol/sdk` at **exactly `0.25.1`** (2026-06-13) in **every** version, while upstream is 1.3.0 — **eleven releases and a major version behind**, on an exact pin that will not float **[reg]** |
| **Actual development age** | **128 commits touching `packages/acp` since 2026-06-16** — two months, and **one month older than the native SDK package** (`packages/sdk`: 160 commits since 2026-07-15). The "six days old" figure is npm-publish age, not development age **[reg]** |
| **Design intent** | Self-described *"automation-only… a transport adapter, not a UI integration or a capability seam."* Its named consumer is `@deepseek-ai/dsh-subagent-acp` (DSH driving DSH as a subagent). **The subsetting is deliberate and aimed at a different consumer than Embassy** **[src][obs]** |
| **No extension usage** | Grep for `_meta` and underscore-prefixed methods: **zero hits.** It uses a plain `meta: {cwd}` on agent creation, not the ACP `_meta` channel. So there is no vendor extension path in place to recover the missing capabilities **[src]** |

### Native SDK JSON-RPC

| Axis | Evidence |
|---|---|
| **Surface** | Tiny and closed: 3 requests (`initialize`, `session/prompt`, `shutdown`), 4 notifications (`session.event`, `session.status`, `subagent.started`, `subagent.finished`). Fully typed in `packages/sdk/protocol/src/types.ts` **[src]** |
| **Stability claim** | The only explicit wire-stability commitment I found **anywhere** in DeepSeek's surfaces: *"`serverInfo.name` stays the wire-stable `deepseek-harness-sdk-runtime`."* Note it commits to the *name*, not the schema **[src]** |
| **Distribution** | Real shipped artifact — single-file bundled executable, PyPI `deepseek-harness-runtime-bin` wheels, no Node required on target. A TypeScript SDK also exists in-repo (`packages/sdk/{protocol,client,server}`) **[src][obs]** |
| **Churn risk** | Inherits all of DSH's: six npm rc's in four days, `SESSION_FORMAT_VERSION = 0` "pre-release, no compatibility implied", README shouting breaking changes, no semver policy. Public repo `pushed_at` = 2026-08-13, three days stale **[reg]** |
| **Cross-SDK drift** | TS `RunResult{sessionId, finalResponse, events, notifications}` vs Python's `RunResult{session_id, final_response, finish_reason, events, notifications, session_root}` (emb-54). **The TS result lacks `finish_reason` and `session_root`.** The two SDKs are not in lockstep **[src]** |

---

## 5. Corrections and closures to emb-54

Six items. Two are corrections, two close stated gaps, two refine claims.

1. **Correction.** emb-54 §1/§5 gave dsh-acp's latest as `0.1.0-rc.6` and framed the license change as BSD-3 → MIT. Accurate about the *version lines*, but **the `latest` dist-tag points at `0.0.1-rc.1`, which is BSD-3-Clause.** The default install is the older build under the older license. **[reg]**
2. **Correction.** emb-54 §1 characterised the native surface as having a typed cancel (`AgentCancelCause`). **True of the in-process harness API; false of the SDK JSON-RPC wire.** There is no cancel method on the native wire. **[src]**
3. **Gap #1 closed.** Native wire method names, previously unverified: requests `initialize` / `session/prompt` / `shutdown`; notifications `session.event` / `session.status` / `subagent.started` / `subagent.finished`. Note the **dot separator** on notifications vs the **slash** on `session/prompt` — an easy thing to get wrong when writing a probe. **[src]**
4. **Gap #2 closed.** The TypeScript SDK was `[search]`-only in emb-54. It is real: `packages/sdk/{protocol,client,server}`, source read directly. Since Embassy is TypeScript, this materially improves the native option. **[src]**
5. **Refinement.** emb-54 §5 rested heavily on "the package is six days old." For dsh-acp that is publish age; development age is two months and predates the native SDK package. The instability signal is real but should be sourced to the rc-churn and the inverted dist-tag, not to age. **[reg]**
6. **Refinement, and it cuts against emb-54 §3.** The typed-`TurnEndReason` advantage cited as write-attestation-grade evidence **exists only on native**; dsh-acp collapses four outcomes into `end_turn` (§2 above). **[src]**

Also relevant to **emb-57** (prerelease/0.x version semantics): dsh-acp's `agentInfo.version` is the hardcoded string `'0.0.1'`. Even if emb-57 taught `VERSION_PATTERN` to parse prereleases, an ACP-sourced DeepSeek version would be a **constant lie** — parseable and wrong. Any probe reading a version must read it from `dsh --version` or the native `serverInfo.version`, never from the ACP handshake.

---

## 6. Recommendation

**Three rulings, separately scoped.**

**(a) For the v1.6 monitor-only slice (Shape A / emb-55 + emb-56): the transport question is moot — keep it that way.** Confidence **high (~90%)**. Shape A does filesystem and `dsh --version` read probes and never opens either protocol. Nothing in this investigation changes emb-54's smallest-slice recommendation, and emb-61 should not be allowed to pull a transport commitment forward into it.

**(b) Reject `@deepseek-ai/dsh-acp` as Embassy's DeepSeek transport.** Confidence **high (~85%)**. Four independent disqualifiers, any one of which suffices: it cannot be spawned (no `bin`, Cordis peer deps, example-from-checkout launch); it collapses four turn outcomes into `end_turn` and settles on agent-idle rather than turn-end, making Embassy's correlation unsound; it exposes no session enumeration; and its handshake version is a hardcoded constant. It is a well-built adapter for its actual consumer — DSH driving DSH as a subagent — and Embassy is not that consumer.

**(c) If and when DeepSeek needs a real transport (Shape B), use the native SDK JSON-RPC.** Confidence **moderate (~70%)**. It wins the requirements that matter most to Embassy — turn lifecycle with ids, and a complete event stream — and it ships an actual spawnable artifact with a real version string. The confidence is only moderate because of one genuine gap: **no interrupt on the wire.** That is narrower than it looks (DSH enforces one turn at a time; sessions are process-scoped; emb-54 §2 already established Embassy's steer path is Codex-only and DeepSeek would fall through to `routeState === "idle"`), and Embassy's cancel would degrade to `shutdown` or subprocess kill — crude but bounded. Still, it is a real absence and it is the reason this is 70% and not 85%.

**And one thing worth escalating, which is not a DeepSeek question at all.**

emb-54 declined Shape C as "ACP-mediated DeepSeek provider — best long-term bet, wrong short-term one." The evidence says the *framing* was too small. **Codex CLI and Claude Agent both appear on ACP's published agents list** **[obs]**. If that holds, Embassy's *existing two providers* already speak ACP. The prize is therefore not "DeepSeek via ACP" — DeepSeek is the weakest ACP implementation of the three. It is "**one ACP client replaces the bespoke 1,014-line `codex-local-transport.ts` and opens ~50 registry agents**," evaluated against Codex and Claude, where the implementations are mature. That is a different, larger, and better-founded bet, it is independent of DeepSeek entirely, and it should be its own investigation rather than a sub-clause of the DeepSeek track. I did not price it.

---

## 7. Honest gaps

1. **I ran nothing.** Every behavioral claim is read from source, not observed. In particular the `whenIdle()` mis-attribution risk (§2) is a reading of the code and its comments; I did not construct a two-producer session to demonstrate a misattributed `stopReason`. **What would resolve it:** run `demo:acp` from a checkout against the repo's mock LLM (`mock:llm` script exists) and drive two concurrent producers.
2. **The Codex-CLI-and-Claude-speak-ACP claim is `[obs]` from ACP's own agents page, one level of summarizer removed** — I read the page's agent list, not each project's ACP implementation. Load-bearing for recommendation (c)'s escalation. **What would resolve it:** fetch the registry JSON at `https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json` and check the Codex/Claude entries' declared capabilities against Embassy's seven requirements.
3. **I did not read the `dsh-acp` test suite** (`packages/acp/acp/tests`), which would confirm the stop-reason mapping behaviorally and may reveal intended-but-undocumented behavior.
4. **I did not read `packages/sdk/server/src/server.ts`**, so the native side's error semantics and its behavior on malformed input are uncharacterized. Relevant to probe safety.
5. **ACP v2's effect on dsh-acp is unmodelled.** dsh-acp is pinned to SDK 0.25.1 and implements v1; v2 is draft with side-by-side support advised. I did not determine whether ACP v2 changes any of Embassy's seven requirements' shapes. Low urgency given ruling (b).
6. **Reasoning-effort configuration in DSH is `[search]`-tier** (per-model selectable efforts, default `high`, `off` sends nothing). I confirmed only the *negative* firsthand — that no effort concept crosses either wire. The positive claim about YAML config is unverified. **What would resolve it:** read `docs/config-catalog.md`'s LLM-plugin section directly.
7. **Cost.** Unchanged from emb-54 and unquantified: any write-path probe on either transport spends real tokens against `DEEPSEEK_API_KEY`. The repo does ship a `mock:llm` script, which may make a keyless write-shaped probe possible — I noted it but did not investigate.

## PM transport ruling (2026-08-16, under founder delegation)

The founder delegated ACP-vs-JSON-RPC to the PM on technical maturity. Ruling, after registry
spot-check of the report's sharpest correction (dist-tag inversion confirmed: latest=0.0.1-rc.1,
BSD-3-Clause, no bin):

1. **dsh-acp REJECTED** as Embassy's DeepSeek transport — four independent disqualifiers, any one
   sufficient: unspawnable (no bin, Cordis peer deps, example-from-checkout launch); collapses four
   turn outcomes into end_turn and settles on agent-idle not turn-end (correlation unsound — the
   observation surface refuses to be observed); no session enumeration; hardcoded handshake version.
2. **Native SDK JSON-RPC ADOPTED** for the Shape B routable provider — wins turn lifecycle with ids
   and full event stream, ships a real spawnable artifact. Known gap accepted: no wire interrupt
   (cancel degrades to shutdown/kill; bounded by one-turn-at-a-time and Codex-only steer).
3. **ACP-universal escalated to founder as a FLAGGED REACH, not enacted**: if Codex CLI and Claude
   Agent genuinely speak ACP (report gap 2 — verify via the ACP registry JSON before believing it),
   the prize is one standard client replacing bespoke transports and opening ~50 registry agents.
   That moves Embassy's differentiation and is the founder's call. Not priced, not scheduled.
4. emb-57 note adopted: any DeepSeek version probe must read dsh --version or native
   serverInfo.version — never the ACP handshake (hardcoded constant).

Remaining in this ticket: the product-type generalization design (PairParams, messageDirections,
ProvenanceEnvelopeDirection) — running now; founder eyes required before implementation.

---

## Generalization design report (2026-08-16, opus agent)

I have what I need. Here is the design report.

---

# emb-61 part 2 — Generalizing Embassy's three closed 2-provider product types to N providers

**Scope:** read-only design. No files modified. Transport is settled (native SDK JSON-RPC) and not revisited.

**What I read directly:** `provenance-envelope.ts` (all 148 lines), `types.ts` (schema regions), `control.ts` (validators, params, snapshot checks, method union), `store.ts` (all persisted validators, the migration chain, `loadStateFile`, `directionFor`/`pairAliasesForRoutes`, pair projection, watch-lease attribution), `dashboard-model.ts` (semantics tables, pair rows, attention scan), `dashboard.ts`, `tab-deliveries.tsx`, `chips.tsx`, `app-types.d.ts`, `live-dashboard-http.ts`, `cli.ts`, `compatibility.ts`, the two `composeProvenanceEnvelope` call sites in `providers.ts`, the `codex-` gates in `claude-helper-protocol.ts` / `claude-helper-supervisor.ts`, `docs/DELIVERY.md`, `docs/GATEWAY-ARCHITECTURE.md:460-512`, and emb-49 §3 / emb-54 §2 for the hazard precedent.

---

## 0. Two corrections to the brief's framing — read these first, they change the design

**(a) `ProvenanceEnvelopeDirection` is not a message direction. It is the recipient provider's rendering dialect.**

Both call sites confirm it: `providers.ts:1717` passes `direction: "claude"` on the path that writes *into* Claude (`CLAUDE_ROUTE_UNAVAILABLE` guards), and `providers.ts:3357` passes `direction: "codex"` on the path that writes *into* Codex (`CODEX_ROUTE_UNAVAILABLE`, `steer`/`queuedAhead`). The file's own header says "at the provider write boundary."

So "adding a third direction" is the wrong operation. The correct operation is **adding a third entry to a recipient-rendering-profile table** — and the profile is chosen by the *recipient*, which means it is `GatewayProvider`-indexed, not direction-indexed. This is much cheaper than the brief assumes, and it also means the type is the *only* one of the three with **zero downgrade exposure**: `composeProvenanceEnvelope` is a pure function, its inputs are never persisted, and its output is transient payload the store explicitly never retains (`GATEWAY-ARCHITECTURE.md:462-464`).

**(b) The envelope has never encoded the sender's provider. Recipients infer it, and the inference is only sound because N = 2.**

The frame carries `from-name` (the verified source alias), `conversation`, `reply-as`, and optionally `from-alias`. No provider field. Today a recipient computes the sender's provider as *"not mine"* — and that is sound, because `directionFor` (`store.ts:2260-2283`) and `pairAliasesForRoutes` (`store.ts:2153-2173`) both hard-throw `INVALID_GATEWAY_ROUTE_PAIR` on same-provider edges, so every routed message crosses between the only two providers that exist.

**At N = 3 that inference silently becomes false.** A Claude recipient seeing `from-name="reviewer@this-mac"` can no longer tell Codex from DeepSeek. No written guarantee is broken; a real, correct, load-bearing recipient inference is. That is the sharpest provenance finding in this pass, and §1c is built around it.

Related, and it closes off the cheap fix: **alias prefixes are not provider proof.** Codex *registrations* must start with `codex-` (enforced in 9 places), but Claude aliases come from Claude's own session names via discovery (`providers.ts:2506-2516`) and carry no enforced prefix — and the shipped skill states the rule explicitly at `skills/embassy-peer/SKILL.md:20`: *"a genuine unmarked Claude session remains visible even when its name starts with `codex-*`."* Using the prefix as a provider assertion would have Embassy claiming something it cannot verify — precisely what `GATEWAY-ARCHITECTURE.md:486-488` forbids for `from`/`from-session`/`from-mode`.

---

## 1. Target shape

### 1a. Direction — a derived ordered provider pair, not a hand-written union

```ts
// types.ts
export const gatewayProviders = ["codex", "claude"] as const;   // + "deepseek" later

export function directionId<F extends GatewayProvider, T extends GatewayProvider>(
  from: F, to: T
): `${F}_to_${T}` { return `${from}_to_${to}`; }

export const messageDirections = orderedProviderPairs(gatewayProviders)
  .map(([f, t]) => directionId(f, t));          // derived, never hand-listed

export type MessageDirection = ...;             // same derivation at the type level
export function parseDirection(d: MessageDirection): { from: GatewayProvider; to: GatewayProvider };
```

Persisted and wire form stays a **flat string**, unchanged. With `gatewayProviders = ["codex","claude"]` the derivation yields exactly `["codex_to_claude","claude_to_codex"]` — same two strings, same values in every existing state file, same values in every snapshot. Adding `"deepseek"` yields six.

Two structural simplifications fall out, and both matter for cost:

- **`deliveryChipByDirection` and `deliveryMeaningByDirection` are recipient-keyed in meaning, not pair-keyed.** The copy proves it: `activity.meaning.delivered.codexToClaude` = *"Embassy wrote the message to Claude's native mailbox immediately"*; `.claudeToCodex` = *"Codex App Server accepted the turn."* Both describe **the recipient's** acceptance semantics. Re-key both tables to `Record<GatewayProvider, key>` — output is bit-identical for the two existing directions, and delivery semantics grow **N, not N²**.
- **Only the route label `direction.claudeToCodex` / `.codexToClaude` is genuinely a pair**, and it becomes compositional: `providerLabel(from) + " → " + providerLabel(to)`. Also N, not N².

Net: `dashboardCopyKeys` grows by ~2 per provider, not ~2N.

### 1b. Pairing — keep the Claude×Codex table exactly, add an optional general table

Constraint that forces the shape: `store.ts:1591-1614` validates the persisted state's **top-level key set exactly**, and `isPairRecord` (`:543-564`) validates the pair record's key set exactly, and `:1764-1776` cross-checks `claude?.binding.provider === "claude" && codex?.binding.provider === "codex"`. A field rename or an added required key is boot-fatal for the previous binary (§2).

**Target:**

```ts
// unchanged, forever — the Claude×Codex consent table
pairs: GatewayPairRecord[];                       // {claudeAlias, codexAlias, claudeOwnerLease, codexOwnerLease, createdAt, updatedAt, counters}

// new, OPTIONAL, omitted entirely when empty
providerPairs?: GatewayProviderPairRecord[];      // {endpoints: [{alias, provider, ownerLease}, {alias, provider, ownerLease}], createdAt, updatedAt, counters}
```

with a single read-side accessor `allConsentEdges(state)` that yields a role-neutral view over both tables, and a canonical ordering function (sort endpoints by `provider` then `alias`) so keys are stable.

Rejected alternatives, with reasons:

- **One generalized table, migrate legacy records forward.** Cleanest code by far. But it rewrites *every* install's pair records on first persist, so a Claude+Codex-only user who never touches DeepSeek loses v1.6 loadability. Violates law 2 for the majority to serve the minority. Rejected.
- **Reuse the two slots as canonical positions** (slot "claude" = provider that sorts first). Lies in the field names *and* doesn't even buy downgrade safety, since v1.6's cross-check follows the alias to the route and demands `provider === "claude"`. Rejected hard.

**Control-wire shape** — keep one method, discriminated params, each arm strictly key-checked:

```ts
export type PairParams =
  | { claudeAlias: string; codexAlias: string; codexThreadId?: string }        // legacy, byte-identical
  | { aliases: [string, string]; threadAttestation?: { alias: string; threadId: string } };
```

The legacy arm keeps `hasExactKeys(value, ["claudeAlias","codexAlias"], ["codexThreadId"])` and its Codex-prefix / Claude-selector / same-host checks **verbatim**, so a v1.6 CLI's `pair` frame is accepted unchanged and takes the identical code path. `gatewayControlMethods` is not touched (adding a method to that closed union has its own cross-binary cost for no benefit).

`codexThreadId` generalizes to `threadAttestation: {alias, threadId}` — the alias names *which* endpoint the attestation is for, checked against that route's registered handle. For Codex with the attestation supplied, behavior is identical to today.

### 1c. Provenance — a recipient-profile table, plus one new hint attribute

**Refactor (bytes provably unchanged):**

```ts
type ProvenanceRecipientProfile = Readonly<{
  fromNameMaxCodepoints?: number;   // present ⇒ bounded display alias + from-alias on shortening
  emitConversationAttribute: boolean;
  allowQueuedAhead: boolean;
}>;

const provenanceProfiles = {
  claude:   { fromNameMaxCodepoints: 64, emitConversationAttribute: false, allowQueuedAhead: false },
  codex:    { emitConversationAttribute: true,  allowQueuedAhead: true  },
  deepseek: { emitConversationAttribute: true,  allowQueuedAhead: false },
} as const satisfies Record<GatewayProvider, ProvenanceRecipientProfile>;
```

Every existing conditional maps one-to-one: `direction === "codex" ? sourceAlias : display.displayAlias` → `profile.fromNameMaxCodepoints === undefined`; the `conversation` attribute → `emitConversationAttribute`; the `input.direction !== "codex"` guard on `queuedAhead` → `!profile.allowQueuedAhead`; the `direction !== "codex" && direction !== "claude"` validator arm → table membership. **The string templates are untouched, so the emitted bytes for `claude` and `codex` are identical by construction**, and the repo's existing exact-wire-shape tests (`test/provenance-envelope.test.ts`; `GATEWAY-ARCHITECTURE.md:197`) prove it rather than asserting it.

**Why DeepSeek gets the Codex-shaped profile, and what that means.** The Claude profile exists for exactly one reason: Claude Code has a *pinned canonical parser* for `<cross-session-message from-name=…>` with a 64-codepoint bound and no `conversation` attribute. That is a fact about Claude's parser, not a fact about being a peer. DeepSeek has no such parser — the native SDK sends `contentBlocks` verbatim as the user message. So DeepSeek takes the fuller frame. The profile names should say so (`bounded_native_parser` vs `verbatim_text`); "codex" and "claude" as *dialect* names are the thing that misled the brief. `allowQueuedAhead: false` for DeepSeek is correct and load-bearing: `queuedAhead` is the STEER marker, and per emb-54 §2 the steer path is Codex-only by construction.

**What a third provider's provenance marking asserts.** Precisely and only:

1. This text entered your context **through Embassy, at the broker's write boundary**, inside exactly one authoritative outer frame.
2. The sender is the **exact alias in `from-name`**, verified by the broker against a live registered route whose owner lease it proved.
3. Here is a participant-scoped conversation locator and the exact `embassy reply` command; caller, membership, and route policy are rechecked at reply time.

Not asserted, now or ever: that the body is safe, that the frame is signed, or (today) which provider the sender is.

**How a recipient distinguishes providers — the recommendation.** Add one broker-owned attribute to the **reply hint**, not the outer frame:

```
<embassy-reply-hint conversation="conv_…" reply-as="…" from-provider="codex">
```

Four reasons for the hint rather than the outer element: the outer element is the one that must satisfy Claude's pinned parser and must stay minimal there; the hint is entirely Embassy-owned in both dialects; the hint already carries a broker-invented attribute (`from-alias`), so the precedent exists; and it renders identically in both profiles, so provenance does not vary by recipient.

The value comes from `binding.provider` on the source route record — proven by owner lease, exactly as strong as `from-name` is today. **No new trust is being asserted; a fact Embassy already verifies is being stated instead of left to inference.**

**This is the one change in the pack that alters the emitted bytes for the two existing providers.** It is additive (no existing attribute changes, no ordering changes), it is caught by the existing exact-wire-shape tests rather than slipping through, and it requires a docs update in `DELIVERY.md`, `DELIVERY.zh-CN.md`, and `GATEWAY-ARCHITECTURE.md`. It is founder question #1.

The alternative — ship nothing and let recipients keep an inference that has quietly become unsound — is cheaper and preserves bytes exactly. I recommend against it, and I've priced both.

### Proof obligations that make "two-provider behavior unchanged" checkable rather than asserted

| # | Obligation | Test |
|---|---|---|
| P1 | `messageDirections` deep-equals `["codex_to_claude","claude_to_codex"]` while `gatewayProviders` is the pair | source-level assertion |
| P2 | `composeProvenanceEnvelope` output is byte-identical across the profile refactor, over the full existing input matrix | golden-bytes, extends `test/provenance-envelope.test.ts` |
| P3 | State written by a v1.7 broker in a Claude+Codex-only session is accepted by v1.6's `isPersistedState` | **frozen copy of the v1.6 validator kept in the test tree**, run against v1.7 fixtures |
| P4 | For a Claude×Codex edge, `providerPairs` is absent from the persisted file and the executed code path is unchanged | store round-trip + path assertion |

**P3 should become a standing test, not an emb-61 artifact.** emb-58 needs the same guard, and it is the only mechanical enforcement of law 2 that exists.

---

## 2. Downgrade safety — the answer is No, conditionally, and the condition is the whole design

### The mechanism, and it is worse than emb-49's

`loadStateFile` (`store.ts:7089-7153`) runs ten migrations, then `isPersistedState`, then throws `CORRUPT_GATEWAY_STATE` on failure. That throw propagates out of `initialize()` (`store.ts:2380-2386`) after releasing the controller lock. **There is no quarantine path and no degrade path. A v1.6 binary that cannot parse the state file refuses to boot at all.**

emb-49 found an escape hatch — probe names are pattern-validated, not list-validated, so a fifth probe rides through an old binary untouched. **There is no equivalent escape hatch anywhere in the provider/direction/pair path.** All four persisted touchpoints are closed:

| Persisted field | v1.6 validator | Widenable? |
|---|---|---|
| `routes[].binding.provider` | `PROVIDERS.has(value.provider)` — `store.ts:398`, set built from `gatewayProviders` at `:137` | **No** |
| `connectors[].provider` | same predicate via `isPrivateEndpointIdentity` — `store.ts:885` | **No** |
| `queue[]`/`inFlight[]`/`events[]`/`dedupe[]` `.direction` | `DIRECTIONS.has(value.direction)` — `store.ts:933, 989, 1036`, set built from `messageDirections` at `:142` | **No** |
| `pairs[]` | exact key set (`:543-564`) **plus** `claude?.binding.provider === "claude" && codex?.binding.provider === "codex"` (`:1767-1776`) | **No** |
| top-level state object | `hasOnlyKeys([...22 keys])` — `store.ts:1593-1614` | **No new required key** |

So: **the first DeepSeek route or connector a v1.7 broker persists makes the state file unloadable by every v1.6 binary.** Not the first message, not the first pair — the first *route*. And the failure is boot refusal for Claude and Codex too, not just for DeepSeek.

Bumping `schemaVersion` to `2` is strictly worse: it breaks v1.6 for every install immediately, including those that never install `dsh`. Rejected.

### The design that survives: deferred taint

Because v1.6's rejection is triggered by *records naming a third provider*, not by the v1.7 binary's existence, the guarantee can be stated exactly:

> **v1.7 persistence invariant.** For any install with no third-provider route, connector, pair, or message, the state file v1.7 writes is shape-identical to what v1.6 writes and loads cleanly under v1.6. Every schema addition must therefore be an **optional key that is omitted when empty**, and every union widening must be **value-space only** — no new fields, no renamed fields, no changed field types, no `schemaVersion` bump.

Consequences, stated plainly:

- Law 2 holds unconditionally for every install that does not opt in. Yesterday's data stays readable by yesterday's binary.
- The downgrade cliff exists, is entered only by an explicit operator action (`register-deepseek`), and is not silent.
- It must be **reversible**, which v1.6 cannot help with — v1.6 has already shipped. The escape has to be v1.7-side.

### Migrate-forward-once plan

There is no forward migration to write: no field changes shape, so the existing ten-step migration chain gains nothing. What is required instead is the **reverse** operation:

1. **`embassy state prune-provider <name>`** — a v1.7 command that rewrites `gateway-state.json` to a v1.6-loadable projection: drop every route, connector, pair, queued/in-flight message, dedupe row, and event naming the pruned provider; drop `providerPairs` entirely; rebuild `accounting`/`counters`/`queuedBytes` so the cross-invariants at `store.ts:1748-1790` still hold; write atomically through the existing temp-file-and-rename path. Refuse to run while the broker holds the lock.
2. **A documented downgrade procedure** in `CHANGELOG.md` / release notes: stop the broker, prune, downgrade. Not a footnote — this is the first Embassy release where rolling back is not free.
3. **P3 as a standing CI test** so the invariant is enforced rather than remembered.

Two-file "downgrade shadow" schemes (v2 at a new path, a v1 projection at the legacy path) were considered and rejected: any binary that then mutates the legacy file forks the state, and there is no honest reconciliation.

### One cross-binary hazard beyond the state file

The control protocol has a single integer version (`GATEWAY_CONTROL_PROTOCOL_VERSION = 1`) checked on **requests only** (`control.ts:930`). Responses are validated **client-side** with exact-key and closed-union checks. `isNormalizedMessageEvent` (`control.ts:1266-1267`) hard-codes `direction === "codex_to_claude" || direction === "claude_to_codex"`, and `isGatewaySnapshot` rejects the **entire snapshot** if any message fails (`:1626-1628`).

**So a v1.6 CLI pointed at a running v1.7 broker that has ever routed a DeepSeek message gets a total `embassy status` failure — not a partial view.** Same for `isPairSnapshot` (`:1191-1203`, exact keys `claudeAlias`/`codexAlias`) and `isGatewayActivityIdentity` (`:1442-1476`, closed kind→action switch). Both binaries ship in one npm package, so this window is the upgrade itself. It should be named in the release notes alongside the state cliff.

---

## 3. Enumerated edit map

Hazard classes:

- **H1** closed persisted/validated union — boot-fatal or snapshot-fatal on widening
- **H2** exact key-set validator — rejects any added field
- **H3** hand-written type literal — **will not fail compilation** when the union widens
- **H4** binary ternary / two-arm branch — silently routes a third value into an existing arm
- **H5** exhaustive mapped type — **will** fail compilation (good; must be filled)
- **H6** enumerated filter / UI site — silently incomplete
- **H7** provider-named API surface (method, param, copy key)
- **H8** alias prefix used as provider proof — unsound per `SKILL.md:20`

| File | Site | Class |
|---|---|---|
| `types.ts` | `:13` `gatewayProviders`; `:59` `messageDirections` | H1 |
| | `:170-179` `GatewayPairRecord`; `:320-353` `GatewayPersistedState`; `:372` `PublicPairSnapshot` | H2 |
| | `:217`,`:248`,`:265` `.direction` fields | H1 |
| | `:515` `gatewayActivityActions` (7 of 11 provider-named) | H7 |
| `store.ts` | `:137` `PROVIDERS`; `:142` `DIRECTIONS` | H1 |
| | **`:391-403` `isPrivateEndpointIdentity` → `PROVIDERS.has`** | **H1 — downgrade-decisive** |
| | `:543-564` `isPairRecord`; **`:1591-1614` top-level `hasOnlyKeys`** | **H2 — downgrade-decisive** |
| | `:904-951`, `:959-1004`, `:1005-1040` direction checks | H1 |
| | `:1764-1776` `pairsValid` provider cross-check | H1/H4 |
| | `:1785` `isValidPersistedMessagePair` literal param | H3 |
| | `:2149-2173` `pairKey` / `pairAliasesForRoutes`; `:2196-2212` `renamePairAlias`; `:2229-2240` `removePairsForAliases` | H4 |
| | `:2260-2283` `directionFor` (literal return type) | H3/H4 |
| | `:2285` `ResolvedEnqueueSides.direction` | H3 |
| | `:4290`, `:4383`, `:4400`, `:4442` direction assignment | H3 |
| | `:4900-4910` public pair projection — `host` derived from `claudeAlias` | H4 |
| | `:6165-6175` watch owner/worker **lease chosen by `claudeAlias` position** | H4 |
| | `:7113-7129` migration chain + `CORRUPT_GATEWAY_STATE` throw | migrate seam |
| `control.ts` | `:128-133` `PairParams` | target |
| | `:809-831` pair/unpair validator (exact keys + `codex-` + Claude selector + same host) | H2/H8 |
| | **`:1266-1267` direction closed check in `isNormalizedMessageEvent`** | **H1 — cross-binary decisive** |
| | `:1191-1203` `isPairSnapshot`; `:1650-1652` snapshot pair↔route provider cross-check | H2/H4 |
| | `:1442-1476` `isGatewayActivityIdentity` closed switch | H7 |
| | `:73-89` `gatewayControlMethods` | H7 |
| `provenance-envelope.ts` | `:17` type; `:44-69` validator; `:106`,`:108`,`:112` dialect ternaries; `:129-135` `queuedAhead` | whole file |
| `providers.ts` | `:1717`, `:3357` compose call sites | target |
| | `:1987` `codex-` prefix on native peer registration | H8 |
| | `:467` `IncompatibleGatewayProvider` surface↔provider coupling (emb-54) | H7 |
| `service.ts` | **`:2093` `adapter(provider: "codex" \| "claude", …)`** | **H3** |
| | `:2119-2137` `assertCrossProviderMutationCompatible` — two hard-coded provider arms | H4 |
| | **`:7502-7503` `hasPair({claudeAlias: conversation.targetAlias, codexAlias: conversation.sourceAlias})` — pair key built by position** | **H4 — live wrong-branch risk** |
| | `:5641-5646` pair matching; `:5587` `planPairInFlightSettlementsLocked`; `:4819-4850`, `:4900-4975`, `:5013` pair flow | H4/H7 |
| | `:1224-1226` `sendToClaude`/`sendToCodex`/`reply` | H7 |
| | `:1268-1276` boot arity (already emb-55) | H1 |
| `dashboard-model.ts` | `:506` `deliveryChipByDirection` — accessed through a `Record<string,…>` cast, **will not fail** | H4/H6 |
| | `:523-524` `deliveryMeaningByDirection` — indexed by `MessageDirection`, **will** fail | H5 |
| | **`:1464-1465` `direction === "codex_to_claude"` unread-write detector** | **H4/H6 — silent semantic loss** |
| | `:1130-1155` pair rows; `:1323-1324` `pairedClaude`/`pairedCodex`; `:1445-1446` provider-by-slot | H4/H7 |
| `dashboard.ts` | `:401` hard-coded `Codex → Claude` / `Claude → Codex` legend | H6 |
| | `:510` direction ternary; `:569` `providerLabel` ternary | H4 |
| `tab-deliveries.tsx` | `:55-58` `DIRECTION_FILTERS: readonly MessageDirection[]` — **will not fail** | H6 |
| | `:60-63`, `:70-73` `Record<MessageDirection,string>` — **will** fail | H5 |
| | `:527-568`, `:721-740` filter UI | H6 |
| `chips.tsx` / `app-types.d.ts` / `shared.tsx` | mirrors of the above | H5/H6 |
| `live-dashboard-http.ts` | `:291-312` pair action: `claude-` **and** `codex-` prefix required | H8/H2 |
| `cli.ts` | `:80-81`, `:615-625` `--claude` / `--codex` flags | H7 |
| `claude-helper-protocol.ts` | `:270`, `:353` `sourceAlias.startsWith("codex-")` | **H8** |
| `claude-helper-supervisor.ts` | `:225` same, on every Claude inbound dispatch | **H8** |
| `claude-peer.ts` | `:607`, `:2378`, `:2602` | H8 |
| `compatibility.ts` | `:3` `compatibilitySurfaces`; `:8-10`, `:38` `satisfies Record<…>` | H1/H5 |
| | `:70` `legacyVersionDriftCode`; `:77-92` `unsupportedVersionCode` ternaries | H4 |
| `dashboard-copy{,.en,.zh-CN}.ts` | `:179-180`, `:198-199`, `:369-370`, `:443` + exhaustive `DashboardCopy` | H5 |

**Two H8 sites are load-bearing safety, not just debt.** `claude-helper-protocol.ts:353` and `claude-helper-supervisor.ts:225` reject any Claude-bound message whose `sourceAlias` does not start with `codex-`, returning `PROVENANCE_ENVELOPE_INVALID`. That means **DeepSeek → Claude is hard-fenced today, fail-closed.** That is a gift: the first routable slice can leave it closed and ship DeepSeek↔Codex only. When it is opened, it must be re-expressed as a check on the source route's `binding.provider`, never on the alias string.

---

## 4. Priced split (rungs 1/2/3/5/8, source lines only)

| Ticket | Scope | Size | Est. source lines |
|---|---|---|---|
| **61a** | **Direction as a derived ordered provider pair.** `directionId`/`parseDirection`; derive `messageDirections`; kill the four H3 literals (`store.ts:1785, 2263, 2285`, `service.ts:2093`); re-key `deliveryChipByDirection` + `deliveryMeaningByDirection` to `Record<GatewayProvider,…>`; compositional route label; derive `DIRECTION_FILTERS` and the `dashboard.ts:401` legend; fix the `:1464` detector. **`gatewayProviders` unchanged, so every emitted and persisted value is identical — a zero-behavior-diff refactor.** | **3** | ~300 |
| **61b** | **Provenance.** (i) profile table, bytes provably unchanged (~90, one file). (ii) `from-provider` on the reply hint + 3 doc files (~50). (iii) re-express the three `codex-` source gates as provider checks (~45). **Founder gate on (ii).** Effort ≈ 2; blast radius maximal. | **3** | ~185 |
| **61c** | **Role-neutral pairing.** Discriminated `PairParams` + `threadAttestation`; optional `providerPairs` table; `allConsentEdges` accessor; union queries across ~55 pair sites in `store.ts`, ~24 in `service.ts`, ~24 in `control.ts`, `dashboard-model.ts`, `live-dashboard-http.ts`, `tab-routes.tsx`, CLI. Touches the durable consent graph — highest blast radius in the repo. **Re-prices to 8 if the watch-lease attribution (`store.ts:6165-6175`) and the succession/rename paths cannot be expressed through the accessor without restructuring.** | **5** | ~470 |
| **61d** | **Downgrade guard + prune command.** `embassy state prune-provider`; frozen v1.6 validator in the test tree as a standing P3 test; release-note procedure. **Must land before any third provider ships.** | **2** | ~180 |
| **61e** | **Add `"deepseek"` to `gatewayProviders`.** After a–d, genuinely small: every site that must change fails compilation via H5. Excludes the adapter and transport, which are their own tickets. Blocked on emb-55/56/57. | **2** | ~120 |

Total **15** across five tickets. Sequencing: **61a → 61b → 61d → 61c → 61e.** 61a and 61b are independently valuable pure refactors with zero behavior change and can land in any release; 61d is the safety precondition; 61c is the one that should own a release lane alone.

---

## 5. Open questions for the founder

**1. The provenance byte change — the only question here that changes what provenance communicates.** Today the frame does not name the sender's provider; recipients infer it as "not mine," which is sound only because there are exactly two providers. At three, that inference silently becomes false. Do we add `from-provider="…"` to the reply hint — additive, sourced from the lease-proven `binding.provider`, asserting nothing Embassy doesn't already verify, but **changing the emitted bytes for Codex and Claude** and touching three docs? Or do we keep bytes exact and accept that a correct recipient inference quietly stops holding? **I recommend adding it.** A provenance marker whose value came from an inference should not lose that value silently.

**2. The law-2 reading.** v1.6's persisted-route validator closes `provider` against a two-member set. It has shipped; it cannot be relaxed retroactively. So the strongest achievable guarantee is: *v1.6 loads v1.7 state cleanly unless and until the operator registers a third-provider route, and a single documented command reverses that.* Is that an acceptable satisfaction of law 2? **If it is not, there is no design that ships a third routable provider** — the constraint is in the already-released binary, not in this design.

**3. Alias namespace.** Should Embassy begin asserting a provider prefix on every route alias — which would mean retiring the shipped rule that a Claude session named `codex-*` is still a valid Claude destination (`SKILL.md:20`)? It would make provenance cheaper. **I recommend no**: it trades a user-facing naming freedom for a fact we can already state honestly from the route record. But it is a values call.

**4. Two pair tables, permanently.** The recommended design keeps the Claude×Codex consent graph on a privileged schema forever, with a second table for everything else. It is the price of downgrade safety for users who will never install `dsh`. Acceptable, or would you rather have one clean generalized table and give up v1.6 loadability for every v1.7 install?

**5. Six directions is a UI question, not just a type question.** At N=3 the deliveries tab needs six filter pills. Should it instead become two independent "from provider" / "to provider" selectors? This is cheaper to decide *before* 61a than after.

**6. DeepSeek alias prefix at registration** — `deepseek-` or `dsh-`, and is it required the way `codex-` is? (Cheap, but it's a naming decision that lands in the CLI and the skill.)

**7. First routable slice scope.** DeepSeek→Claude is currently hard-fenced by the helper's `codex-` source gate, fail-closed. Ship the first routable slice as **DeepSeek↔Codex only**, leaving that gate shut? It removes the entire Claude-ingress surface from the first landing and costs nothing to open later.

## PM acceptance + recommendations (2026-08-16) — AWAITING FOUNDER on the seven questions

Report ACCEPTED; load-bearing claims spot-checked (codex- source gates at
claude-helper-supervisor.ts:225 / claude-helper-protocol.ts:353 verbatim; the H3 direction literal
at store.ts:1785 verbatim). emb-61's deliverable is complete: transport ruled (native JSON-RPC),
generalization designed and priced (61a-e, total 15 across five tickets, sequencing a→b→d→c→e).
Sub-tickets will be drafted AFTER the founder answers — several answers reshape them.

PM recommendations on the seven founder questions:
1. from-provider on the reply hint: ADD IT (concur with report) — an inference silently going
   false is worse than an additive byte change caught by exact-wire tests.
2. Law-2 reading: the deferred-taint guarantee is an honest satisfaction — the cliff is entered
   only by explicit operator action and reversed by one documented command. Founder's law, founder's call.
3. Alias-prefix-as-provider-proof: NO (concur) — state the fact from the lease-proven route record.
4. Two pair tables permanently: YES — it is the price of never bricking a Claude+Codex-only install.
5. Deliveries filter UI: two from/to provider selectors over six direction pills.
6. DeepSeek registration prefix: require `deepseek-` at registration, mirroring the codex- asymmetry.
7. First routable slice: DeepSeek↔Codex ONLY, Claude-ingress gate stays shut (concur) — the
   existing fail-closed fence is a gift; opening it is its own later decision.
