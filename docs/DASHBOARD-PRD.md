# Embassy Dashboard — Product Requirements (Web App)

Owner: PM. Status: the five-tab web app, bounded retained-body display, and its
four bounded route actions have shipped; editable settings, registration
handshake, and the remaining §6b ambitious scope are gated on broker work plus
the standing threat-model review. Pair this with the companion design MD for
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
non-negotiable: exact IPv4 loopback on stable port `41961` by default (or the
per-invocation `--port <n>`), with a direct root URL that supports multiple
windows and browsers. There is no authentication ceremony: no token, fragment,
cookie, per-browser session, random instance path, or bootstrap file. The
product assumes a trusted single-user machine because local software that can
reach or spoof loopback can read the live view, including bounded retained
bodies, and invoke its bounded actions. The static dashboard remains
metadata-only. The app is read-MOSTLY: its
sole mutations are exact pair, unpair, discovery refresh, and broker-guarded
stale-Codex-registration removal actions, shipped behind their standing threat-model review,
carried over exact-Origin + sentinel-header POSTs per the live contract. The
server checks exact Host on every request, sends no CORS headers, and rejects
`OPTIONS`. Never register/send/reply/approve/interrupt
from a browser, ever.

## 3. The operator's questions → the IA

Five tabs, one question each:

### 3.1 Overview — "Is everything OK right now?"
- Status strip: broker health, lease state, both connector healths, and the
  automatic exact-version compatibility result — as glanceable state chips,
  not numbers. Compatibility is passive status, never an operator action.
- The **exchange board**: the two directions rendered as a diagram —
  selected Claude session ↔ queue/pouch ↔ registered Codex task — with live
  state on each node (idle/busy/waiting) and direction-specific edges. The
  Codex-bound edge shows queue depth and oldest age while the task is busy; the
  Claude-bound edge shows immediate mailbox-write progress regardless of
  Claude's observed state. It must never imply that busy Claude gates a write.
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
  expiring against long Codex receiver turns). The lifecycle must branch by
  direction: Claude-bound `transport_written` is the terminal `delivered`
  mailbox-write boundary, not proof of later reading or consumption;
  Codex-bound ordinary work remains idle/turn-boundary gated.
- **Conversation grouping**: `conv_` threads render as exchanges (request →
  reply chains), not isolated rows.
- State vocabulary discipline (carries the honesty brand): progress is never
  styled as success; `released` explicitly ≠ read; `unconfirmed` and
  `ambiguous` are visually distinct from `failed`; `abandoned` is annotated
  "broker stopped before settlement — by design."

### 3.3 Routes & Sessions — "Who can talk to whom, and why not?"
- Topology first: discovered ≠ selected ≠ registered made visible as
  concentric consent states. Routes render as **pairs**: selection is
  bidirectional (the selected Claude session is the only accepted inbound
  sender for the registered task; unpaired senders are refused with a
  terminal receipt). If the operator enables the explicit `--inbound open`
  mode, the topology says so loudly ("any live same-UID Claude session may
  message this task").
- Per-session detail (progressive disclosure): Claude sessions — discovery
  state, selection binding (UUID-backed; restored/stale/reactivated),
  rename history as it affects addressing. Codex route — policy summary,
  identity lock, write-gate state with the *reason* when monitor-only.
- **Succession history**: each succession as an event card — predecessor,
  successor, drain outcome, what settled terminally; nothing transfers, and
  the card says so.
- **Actions (the tab's mutations — the only ones in the app):**
  *Pair* or *Unpair* exact Claude/Codex endpoints, *Refresh discovery*, and
  request removal of a named stale Codex registration. The recovery action is
  shown only on stale Codex rows and the broker accepts it only when the owning
  endpoint generation is dead; it never accepts a task ID or generation from
  the browser.
  Requirements: each action shows a one-line consequence before confirming
  (including the stale-and-dead-generation guard for recovery);
  actions use exact-Origin + sentinel checks, are rate-limited, and every
  invocation lands in the Activity
ledger with an operator-action marker. Automatic endpoint refresh also lands
in that ledger, distinctly marked automatic rather than operator. Failures surface the same safe
  codes the CLI would print. **Registration is a flow, not a button**: identity must be inherited
  inside the Codex task, so the tab initiates a registration offer
  (short-lived, alias pre-authorized) and displays the one-line claim
  command for the task to run — then shows the claim completing live. See
  §6b.

### 3.4 Activity — "What happened while I was away?"
- Unified bounded event stream: deliveries (terminal only, by default),
  discovery changes, selection changes, registrations/successions, lease
  events, alerts raised/cleared. Filter by kind. Relative timestamps with
  absolute on hover.

### 3.5 Diagnostics — "Is my setup right for my workflow?"
- Version pins vs detected versions; automatic startup and endpoint-generation
  validation state per surface; safe failure codes; lease/instance detail;
  state-directory location. No manual compatibility or override control
  belongs in the dashboard.
- Configured limits vs observed pressure, side by side: queue depth vs cap,
  message deadline vs the observed distribution of receiver turn lengths
  (the 5-minute-deadline-vs-hour-long-turns mismatch we hit repeatedly must
  be *visible here as a recommendation*: "your deadline expired N messages
  this week; consider EMBASSY_MESSAGE_DEADLINE_MS=...").
- Counters and byte budgets, collapsed by default.

## 4. Cross-cutting requirements

- **Progressive disclosure everywhere**: chip → row → detail pane. No screen
  shows raw JSON by default; every detail pane offers it behind "raw".
- **Live by stream**: views update via the same-origin snapshot stream;
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

- Mid-generation interruption stays out permanently (the Desktop stop
  button's equivalent — stopping a turn mid-generation is undefined behavior
  for an agent, per the operator's clarified ruling). Boundary-delivered
  steering is explicitly IN scope. Approvals stay native to each agent.
- No remote access, accounts, cloud, or telemetry — ambition stays local.

## 6b. Remaining ambitious scope (user-directed; each item gates on broker
work + threat-model review)
- **Full consent management including registration**: select/unselect
  (already specified in 3.3), steering kill-switch state, and
  **dashboard-initiated registration** — designed as a two-sided handshake
  that preserves identity honesty: the operator creates a registration
  offer in the dashboard (alias pre-authorized, short-lived), the Codex
  task claims it by running one short command in its own process (identity
  inherited where it truly lives), and the dashboard shows the claim
  completing live. The dashboard is the initiating and supervising surface;
  the task remains the identity anchor. Exact mechanism is engineering's
  to propose behind the standing threat-model review.
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
