---
id: emb-61
title: Routable DeepSeek provider — transport decision + product-type generalization (design)
kind: investigation
size: 3
status: building
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
