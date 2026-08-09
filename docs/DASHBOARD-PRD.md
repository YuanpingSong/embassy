# Embassy Dashboard — Product Requirements (Web App)

Owner: PM. Status: requirements for the full web-app dashboard that succeeds
the single-page HTML dashboards. Pair this with the companion design MD for
visual tokens; this document is the product truth. The static mode-0600 file
remains the inert offline floor and is out of scope here.

## 1. Why a web app

The single page failed for a structural reason: Embassy produces six
different *kinds* of data (broker state, consent topology, per-delivery
lifecycles, queues under pressure, an audit trail, and configuration/
compatibility), and a single scroll forces them into one flat plane. The data
needs progressive disclosure — glance → scan → trace — and an information
architecture organized by the operator's questions, not by our storage
schema.

## 2. User & posture

One persona: the **solo operator** — the person running both agents on their
own Mac. They visit in two modes: *ambient* (is everything fine?) and
*forensic* (a specific message or route is misbehaving). Design every view to
answer the ambient question in under 3 seconds and to begin a forensic trace
in one click.

Security posture is inherited from the shipped live contract and is
non-negotiable: loopback-only, one-use token bootstrap; metadata only —
**message bodies never appear anywhere, ever**. The app is read-MOSTLY: the
sole mutations are the operator's consent operations — select, unselect,
and snapshot refresh — shipped behind their standing threat-model review,
carried over the authenticated session (exact-Origin + sentinel-header
POSTs per the live contract). Never register/send/reply/approve/interrupt
from a browser, ever.

## 3. The operator's questions → the IA

Five tabs, one question each:

### 3.1 Overview — "Is everything OK right now?"
- Status strip: broker health, lease state, both connector healths, version
  compatibility — as glanceable state chips, not numbers.
- The **exchange board**: the two directions rendered as a diagram —
  selected Claude session ↔ queue/pouch ↔ registered Codex task — with live
  state on each node (idle/busy/waiting) and edge (queue depth, oldest age).
- **Needs attention**: ordered, actionable, hidden entirely when empty.
  Every alert pairs state with the exact next CLI command, copyable.
- Activity pulse: last-hour delivery counts by terminal state (small
  sparkline; links to Deliveries filtered to that state).

### 3.2 Deliveries — "Where is my message?" (the forensic core)
- Filterable, searchable ledger: direction, state, route, conversation,
  time range. Paste a `dlv_` token or `conv_` token to jump straight to it.
- **Row → lifecycle timeline**: every transition with timestamps — accepted
  → queued (with age) → dispatched → transport-written → released/delivered,
  or unconfirmed / ambiguous / expired / failed / cancelled / abandoned —
  including stall notices fired and diagnostic frames emitted, each with its
  safe code. This is the single most important screen in the product: it is
  the answer to the incident class we lived through (messages silently
  expiring against long receiver turns).
- **Conversation grouping**: `conv_` threads render as exchanges (request →
  reply chains), not isolated rows.
- State vocabulary discipline (carries the honesty brand): progress is never
  styled as success; `released` explicitly ≠ read; `unconfirmed` and
  `ambiguous` are visually distinct from `failed`; `abandoned` is annotated
  "broker stopped before settlement — by design."

### 3.3 Routes & Sessions — "Who can talk to whom, and why not?"
- Topology first: discovered ≠ selected ≠ registered made visible as
  concentric consent states, with the asymmetry stated (a registered
  `codex-*` task is reachable by every live same-UID Claude session).
- Per-session detail (progressive disclosure): Claude sessions — discovery
  state, selection binding (UUID-backed; restored/stale/reactivated),
  rename history as it affects addressing. Codex route — policy summary,
  identity lock, write-gate state with the *reason* when monitor-only.
- **Succession history**: each succession as an event card — predecessor,
  successor, drain outcome, what settled terminally; nothing transfers, and
  the card says so.
- **Actions (the tab's mutations — the only ones in the app):**
  *Select* on any discovered, compatible Claude session and *Unselect* on
  the current selection, right in the topology; plus *Refresh discovery*.
  Requirements: each action shows a one-line consequence before confirming
  ("Selecting makes this session the destination Codex can send to");
  actions ride the authenticated session with exact-Origin + sentinel
  checks, are rate-limited, and every invocation lands in the Activity
  ledger with an operator-action marker. Failures surface the same safe
  codes the CLI would print. **Registration is deliberately NOT a button**:
  it must run inside the Codex task to inherit its identity, so the tab
  shows the copyable `register-codex` command with the ask-your-agent note
  instead — a button here would be a lie about how identity works.

### 3.4 Activity — "What happened while I was away?"
- Unified bounded event stream: deliveries (terminal only, by default),
  discovery changes, selection changes, registrations/successions, lease
  events, alerts raised/cleared. Filter by kind. Relative timestamps with
  absolute on hover.

### 3.5 Diagnostics — "Is my setup right for my workflow?"
- Version pins vs detected versions; compatibility state per surface;
  attestation results; lease/instance detail; state-directory location.
- Configured limits vs observed pressure, side by side: queue depth vs cap,
  message deadline vs the observed distribution of receiver turn lengths
  (the 5-minute-deadline-vs-hour-long-turns mismatch we hit repeatedly must
  be *visible here as a recommendation*: "your deadline expired N messages
  this week; consider EMBASSY_MESSAGE_DEADLINE_MS=...").
- Counters and byte budgets, collapsed by default.

## 4. Cross-cutting requirements

- **Progressive disclosure everywhere**: chip → row → detail pane. No screen
  shows raw JSON by default; every detail pane offers it behind "raw".
- **Live by stream**: views update via the authenticated snapshot stream;
  every screen carries "as of <time>" and degrades gracefully to manual
  refresh when the stream drops (visible reconnect state, never a stale
  page pretending to be live).
- **Empty states teach**: each tab's empty state names the exact command
  that would populate it (e.g., no registered task → `embassy
  register-codex --alias codex-<name>@<host>` with the ask-your-agent note).
- **Bilingual**: en / zh-CN from the existing typed catalog; protocol
  tokens, commands, state codes stay English in both locales.
- **Accessibility**: keyboard-complete, visible focus, WCAG AA contrast,
  reduced-motion respected, forced-colors usable; tables have real captions.
- **Search is global**: alias, token, or safe code from any tab.
- **Time honesty**: everything relative + absolute; the snapshot moment is
  always displayed; clock skew never implied to be zero.

## 5. Voice & feel (defer tokens to the design MD)

Warm and personable in the new brand family (the tent/mascot era) — the
mascots may appear in empty states and onboarding moments, never inside data
displays. Data surfaces stay calm and editorial: the ledger reads like a
well-kept register, not a wall of telemetry. Semantic colors keep their
meanings from the canon (positive/waiting/failure kept distinct from brand
accent); the honesty rules (never overclaim a state) are design requirements,
not copy suggestions.

## 6. Non-goals

- Approve and interrupt stay native-only (interrupt permanently, per the
  operator's standing ruling; approvals belong to each agent's own flow).
- No remote access, accounts, cloud, or telemetry — ambition stays local.

## 6b. Ambitious scope (user-directed; each item gates on broker work +
threat-model review)

- **Message content, opt-in**: the broker gains a bounded operator-review
  retention window (last N bodies, off by default, size-capped, disclosed in
  SECURITY). The Deliveries timeline then shows what was said, not just
  when; previews truncate, full body behind disclosure. When retention is
  off, the UI says so honestly instead of pretending there is nothing.
- **Operator console**: operator-originated send and reply as a NEW
  first-class protocol identity (no such verb exists today even in the CLI —
  agent identities are inherited, not impersonated). The dashboard becomes a
  participant surface: compose to any consented route, thread into
  conversations, with operator provenance stamped on every message and
  ledger row.
- **Full consent management**: select/unselect (already specified in 3.3)
  plus steering kill-switch state and, if engineering finds an honest
  identity path, browser-assisted registration flows.
- No remote access, no accounts, no cloud, no telemetry.
- No replacement of `embassy status` for agents — this is a human surface;
  agents keep the CLI.

## 7. Success criteria

1. A stranger with a running Embassy answers "is it working?" in ≤3 seconds
   and "why did message X not arrive?" in ≤3 clicks from landing.
2. Every state the delivery FSM can produce is reachable, explained in one
   sentence on hover, and visually honest about progress vs success.
3. The deadline-mismatch insight from Diagnostics prevents the silent-expiry
   pattern we lived through — the operator is told, with numbers, when their
   configuration fights their workflow.
4. Both locales ship simultaneously from one catalog.
