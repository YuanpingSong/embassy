# Change Order — Paired Routes (Dashboard Design)

Product model change, PM-approved, supersedes the "asymmetry" language in
earlier PRD revisions. Status: designed, not yet implemented — the broker
still ships the asymmetric model, and shipped surfaces must keep describing
that reality until this lands. Design against this document as the target.

## What changed

**Before**: consent was asymmetric. Selecting a Claude session gated only
the Codex→Claude direction; once a Codex task was registered, *any* live
same-UID Claude session could message it. The dashboard had to carry a
warning stating this.

**After**: **selection is bidirectional consent.** The selected Claude
session and the registered Codex task form a **pair** — the selected
session is both the destination Codex can send to *and the only inbound
sender the task accepts*. Messages from any other session are refused
terminally with the safe code `SENDER_NOT_PAIRED` (sender sees it in their
native receipt). An explicit opt-out — **open mode** — restores the old
any-session behavior and must look deliberately chosen, never default.

One nuance to render honestly: native *visibility* is unchanged (any
session still sees the `codex-*` peer in its own ListAgents — that registry
is Anthropic's and machine-wide). What the gateway now gates is
*acceptance*. Copy should say "accepts messages only from its paired
session," never "is invisible to others."

## Screen-by-screen impact

1. **Routes & Sessions — topology**: routes render as a **bonded pair**
   (one edge, two enrolled ends), not as two independent consent rings.
   Remove the asymmetry callout entirely. Unselected-but-discovered
   sessions render as candidates, visually outside the pair.
2. **Select/unselect consequence dialogs** (the confirm step in the
   Actions block): copy becomes — Select: "Pair this session with
   codex-<alias>? It becomes the destination Codex sends to, and the only
   sender the task accepts." Unselect: "Unpair? The task will accept no
   inbound messages until another session is paired."
3. **Overview — exchange board**: the center edge is the pair. New edge
   state: *no pair* (registered task + no selection) — the task accepts
   nothing; make that state legible, not alarming.
4. **Deliveries ledger**: new terminal refusal rows (`SENDER_NOT_PAIRED`)
   with the standard safe-code treatment. They are *by-design refusals*,
   not failures — style with the neutral/ink family, not error styling.
5. **Activity**: refusal events appear in the stream. Repeated refusals
   from the same unpaired session may surface one Needs-attention hint:
   "<alias> tried to message codex-<alias> N times — pair it, or ignore."
   (Pair-from-hint is allowed: it's the same select action.)
6. **Open mode**: if the operator runs with `--inbound open`, the topology
   and Overview show a persistent, distinctly-styled badge — warning-tier,
   with the old sentence as its body: "Open inbound: any live Claude
   session under this OS user may message this task."
7. **Empty states**: registered + nothing selected now means "accepts no
   one" — update the empty-state teaching line accordingly (the next
   command is still `embassy select-claude --alias <name>`).

## What does NOT change

- The mutation set (select / unselect / refresh / registration handshake).
- The registration handshake flow (separate change, already specced).
- Steering semantics and the mid-generation interrupt ban.
- Deliveries timeline, Diagnostics, search, i18n, accessibility reqs.

## Acceptance

A first-time viewer of the Routes tab should describe the model as "each
route is a pair both sides agreed to" without reading a caveat. The open
mode badge should make a reviewer ask "did I mean to do that?"
