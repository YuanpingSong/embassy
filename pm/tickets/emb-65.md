---
id: emb-65
title: ACP ground truth — registry, spec versioning, and delivery-signal fidelity across dsh and grock
kind: investigation
size: 2
status: landed
release: v1.7
updated: 2026-08-16
---

## Binding

**Why**: the founder ruled v1.7 transport = ACP the open standard (emb-61 R1),
superseding the native JSON-RPC ruling that was driven by defects in the
dsh-acp adapter. Before the new sub-ticket split is priced, every defect that
drove the old ruling must be re-classified: inherent to ACP the standard
(design must absorb it), specific to the dsh adapter (route around it), or
stale (fixed upstream / version-specific to the rc build).

**Deliverable**: a report answering, with cited sources (registry JSON, spec
text, adapter source/releases):
1. ACP registry ground truth — is the agents list real and current; are Codex
   CLI and Claude Agent actually on it (the flagged ACP-UNIVERSAL reach);
   what does one-client-many-agents actually buy Embassy?
2. Spec/version story — how is the ACP handshake versioned; what does a
   client do across agents pinned to different spec versions; is the dsh-acp
   hardcoded-handshake-version defect an adapter bug or a spec gap?
3. Delivery-signal fidelity — can an ACP client obtain reliable
   turn-completion / turn-outcome and session-list signals from (a) the dsh
   build and (b) the grock build? This is deliverability, not certification:
   Embassy's receipts need honest terminal states. Reclassify the emb-61 §2
   turn-outcome-evidence finding.
4. Spawnability/packaging — current dist-tag state of dsh-acp; whether the
   standard client connects to an already-running harness without adapter
   packaging at all.
5. The minimal ACP client surface Embassy needs (methods, notifications) for
   best-effort send → deliver → reply with graceful, clearly-surfaced errors —
   ceremony-free per emb-61 R2.

**Budgets**: size 2, investigation. Read-only: registries, specs, source,
releases. No harness is launched; no write authority exists or is implied.

## Standing mandate (founder, 2026-08-16)

This ticket is the sole gate on v1.7: if the investigation shows ACP is NOT
sufficient for Embassy's usage (reliable turn-completion/receipt signals for
best-effort delivery), the founder revisits the transport ruling. Otherwise
the PM drives the full v1.7 release to ship without further founder inputs.

## Report (2026-08-16, opus agent — condensed record; verdicts + tables kept, narrative pruned)

Method: registry APIs queried directly, spec pages fetched, adapter sources
read; ONE tarball (@xai-official/grok, 17KB) extracted read-only. Nothing
installed/launched/executed; no credentials touched.

**V1 — Registry**: real, machine-readable, current within the hour
(cdn.agentclientprotocol.com/registry/v1/latest/registry.json; 38 agents, not
"50+"). Codex (codex-acp v1.4.0, OpenAI/JetBrains/Zed, released TODAY), Claude
(claude-agent-acp v0.69.0, Anthropic/Zed/JetBrains, released TODAY), and Grok
Build (xAI, ACP compiled into the native binary, no adapter) are all on it.
The registry is a checksummed spawn table (21 npx, 17 binary+sha256, 2 uvx) —
but carries ZERO capability metadata (capabilities exist only in the runtime
initialize response) and DEEPSEEK IS NOT ON IT AT ALL.

**V2 — Versioning**: protocolVersion is a single integer bumped only on
breaking changes, negotiated per-connection at initialize (MUST-level rules).
PROTOCOL_VERSION = 1 in BOTH sdk 0.25.1 and 1.3.0 — dsh's "major version
behind" pin has zero wire consequence. v2 is still Draft with shipped
side-by-side support. dsh's "hardcoded handshake version" was HALF NON-DEFECT
(single-version agents answer their own version per spec) and half cosmetic
(agentInfo.version constant '0.0.1'; other adapters use packageJson.version).
CONSEQUENCE: narrow the emb-57 rule to "treat agentInfo.version as
unverified", not "never read a version from the handshake".

**V3 — Delivery signals**: the spec MANDATES Embassy's receipt requirement —
the session/prompt RESPONSE carries one of five StopReasons (end_turn,
max_tokens, max_turn_requests, refusal, cancelled), correlated by JSON-RPC id;
cancellation MUST settle as cancelled. claude-agent-acp uses all five with
sound per-turn settlement; codex-acp uses end_turn/cancelled honestly + typed
failures over _meta (AIR), plus a declared _session/steering extension and
_meta.claudeCode.promptQueueing on Claude's — both Embassy concepts have ACP
counterparts. dsh-acp UNIQUELY violates the spec: codec collapses
aborted/blocked/error→end_turn and settles on whole-agent idle, not the turn
(reconfirmed live on master, unchanged since emb-61). session/list is
stabilized, capability-gated, implemented by codex+claude adapters, honestly
unadvertised by dsh. Grok's fidelity: UNKNOWN read-only — needs exactly one
initialize round-trip, which is the same connect-time code path Embassy needs
anyway (per R2: read capabilities at connect, degrade honestly, no advance
certification).

**V4 — Packaging/spawnability**: dsh-acp unspawnable CONFIRMED LIVE and worse
than emb-61 stated: no bin field, no executable in files, five workspace:^
peerDeps unresolvable off-registry, dist-tags still inverted (latest =
0.0.1-rc.1 BSD build). Every OTHER registry agent is npx/binary-spawnable
with checksums. AND the load-bearing inherent limit: ACP v1 is SPAWN-ONLY —
"the client launches the agent as a subprocess"; no attach to a running
process (HTTP transport still draft). session/list+resume replay on-disk
transcripts in a NEW process; they are not a channel into the user's live
TUI. CONSEQUENCE (architectural): replacing Embassy's existing Codex/Claude
transports with ACP would be a PRODUCT CHANGE (delivering into the user's
live session vs driving an Embassy-owned agent), not a refactor.

**V5 — Minimal ceremony-free client surface**: outbound initialize (minimal
clientCapabilities: fs/terminal all false; store per-connection
protocolVersion + agentCapabilities as the sole truth), session/new,
session/prompt (THE receipt; map five stop reasons uncollapsed),
session/cancel; authenticate only on demand and never touching credentials.
Capability-gated: session/list / resume / load. Inbound handlers:
session/update (13 variants; consume agent_message_chunk, ignore the rest
silently) and session/request_permission — MANDATORY, ungated, the #1 hang
risk; answer cancelled/deny, NEVER auto-allow. Reply -32601 to any un-declared
inbound request. Error surfacing: -32601 disable-feature-per-connection;
-32602/-32603/-32002 verbatim onto the receipt; -32000 report-don't-remediate.
Subprocess death with a prompt outstanding = UNKNOWN, the one terminal state
Embassy must invent. Total: 5 methods out (2 conditional), 2 handlers in.

**Reclassification of the 7 rejection-driving defects**: 5 adapter-specific
(turn-outcome collapse — spec-violating; idle settlement — spec-violating; no
session enumeration; dist-tag inversion; unspawnable packaging), 1 mis-scored
non-defect (handshake version), 1 stale (SDK pin — zero wire consequence).
Plus: per-turn model/effort control is INHERENT to ACP's session-level config
(not adapter-withheld); v2 churn inherent-but-bounded; no-attach inherent.

## GATE VERDICT (PM, 2026-08-16): ACP IS SUFFICIENT — mandate holds, drive continues

The revisit trigger does not fire: reliable turn-completion/receipt signals
are a spec GUARANTEE that only the dsh adapter breaks. Two PM rulings issued
on the report's consequences (both under delegated detail authority,
founder-vetoable, surfaced in the founder summary):

**PM ruling A (attach-vs-spawn)**: v1.7 does NOT replace the existing Codex
app-server and Claude native-peer transports — they deliver into the user's
LIVE sessions, which is Embassy's core product; ACP v1 cannot (spawn-only).
ACP is the transport for NEW providers, whose sessions Embassy owns.

**PM ruling B (the DeepSeek lane)**: DeepSeek is not an ACP registry citizen
and its adapter is unspawnable from npm and lies in its receipts
(spec-violating stop-reason collapse). v1.7 still ships DeepSeek routable:
launch dsh-acp from the LOCAL harness checkout (present on this machine,
emb-56-attested), document the lane's receipts as coarse-fidelity (the
collapse is adapter-side; nothing client-side can recover it), and file the
stop-reason fix upstream. When DeepSeek publishes a spawnable, honest
adapter, the lane upgrades for free. Grok Build becomes routable via the
checksummed registry spawn in the same release — the ACP-universal proof.

New split priced: emb-66 (de-ceremony design, 3) → emb-67 (ACP client
transport, 5) → emb-68 (N-provider generalization: all-to-all, unified native
state, from/to-provider, dsh- prefix, 5) → emb-69 (DeepSeek + Grok provider
definitions, 3). Old 61a-e remains superseded.
