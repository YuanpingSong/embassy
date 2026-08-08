# Embassy Phase 2 copy brief

You are the product-copy writer for Embassy, an open-source macOS tool. Draft
all requested user-facing prose. Do not call tools, read files, browse, or make
implementation changes. Return only one polished Markdown document with the
five named deliverables below plus a short "Copy risks / decisions" section.

## Product truth (must remain exact)

- Embassy is a personal, same-machine, same-OS-user local broker between
  already-running Claude Code sessions and Codex desktop tasks. It is
  unofficial and not affiliated with Anthropic or OpenAI.
- The broker uses local Unix-domain sockets and the already-running Codex App
  Server. It makes no provider API call and sends no telemetry. The agents are
  cloud-backed: delivered text becomes an ordinary model turn and reaches
  Anthropic or OpenAI under that product's normal behavior. "Local" describes
  the broker and route, not model inference.
- Embassy does not spawn, orchestrate, wrap, replace, or reimplement agents.
- Claude to Codex: one Codex task explicitly registers itself. That advertises
  it to compatible live Claude sessions of the same OS user. A compatible live
  Claude session can initiate native delivery to the registered Codex task
  under the task's existing native approval and sandbox policy. Inbound
  reachability does not select that Claude session for outbound use.
- Codex to Claude: the Codex task must be registered and a compatible discovered
  Claude session must be explicitly selected before sending. Discovery is not
  selection. Sending never auto-selects.
- Registration, discovery, and selection are distinct states.
- CLI acceptance returns a conversation token but does not prove delivery.
  Accepted is not delivered. Progress states include queued, dispatching,
  transport written, held, and stalled. Terminal states include delivered,
  expired, rejected, cancelled, abandoned, failed, and ambiguous (and duplicate
  where appropriate). Do not imply that accepted means received.
- Messages queue while Codex is busy; Embassy does not steer another turn.
  Bodies are bounded to 16 KiB and memory-only inside Embassy. There is no replay
  after restart.
- The dashboard exposes metadata only: aliases, public conversation/message
  tokens, states, timestamps, byte counts, queue depth/age, and safe codes. It
  never shows message bodies, raw provider frames, native UUID/thread IDs,
  callback/socket paths, credentials, transcripts, Keychain data, or provider
  history.
- Embassy does not change or answer native approval/sandbox policies. Claude's
  `crossSessionInbound` remains Claude's native inbound control.
- Same-UID containment is not authentication against malicious processes already
  running as the user.
- Exact pinned provider versions fail closed when incompatible.
- Current target: macOS, Node.js 20 or newer, Claude Code 2.1.225, and Codex App
  Server 0.147.0.
- Commands stay English and literal. The installed package is `agent-embassy`
  and the CLI is `embassy`.
- Essential quickstart sequence:
  1. `npm install -g agent-embassy`
  2. `embassy serve`
  3. `embassy health` and `embassy status`
  4. Inside the target Codex task:
     `embassy register-codex --alias codex-reviewer@this-mac`
  5. Operator: `embassy select-claude --alias advisor@this-mac`
  6. From that registered task, with the body over stdin:
     `embassy send-to-claude --from codex-reviewer@this-mac --to advisor@this-mac --expects-reply`
  Explain that acceptance is asynchronous and delivery must be checked.

## Brand and voice

- Design direction: "Porcelain & Seal": warm porcelain paper, near-black ink,
  one cinnabar seal accent, jade for delivered/healthy, ochre for waiting, and a
  separate error red. Abstract seal mark: opposing chevrons meeting at a sealed
  center. No buildings, flags, vendor colors, circuit-board AI imagery, generic
  SaaS jargon, or hype.
- Voice: composed, editorial, precise, warm, quietly memorable. Short sentences
  where possible. No corporate filler, anthropomorphic overreach, "seamless",
  "revolutionary", "secure by design", or absolute safety claims.
- The Embassy metaphor may explain: accreditation means registration/selection,
  register/ledger means receipts, and pouch means bounded in-memory transit. Do
  not let metaphor obscure protocol.
- English is canonical for security meaning. zh-CN should sound native and
  professional, not word-for-word translated. Retain Embassy as the product
  name. First mention may be “Embassy（AI 智能体使馆）” if natural. Use “智能体” for
  agent. Use “本机” and “同一 macOS 用户” accurately. Avoid translating local in
  a way that implies offline inference.
- Claude Code, Codex, command names, JSON keys, enums, aliases, and safe error
  codes remain untranslated in zh-CN.

## Current product copy and IA problem

- The existing site is technically correct but generic and leads heavily with
  negation/security. Elevate it into an editorial product story grounded in one
  authentic exchange.
- The existing dashboard is a generic admin wall with KPI cards and tables. Its
  new IA is:
  1. Exchange board: Claude selection ↔ queue/pouch ↔ Codex registration, broker
     readiness, and next action inline.
  2. Needs attention: ordered, actionable, hidden when empty.
  3. In transit: queue count, oldest wait, and stalled state.
  4. Activity ledger: receipt lifecycle, details on demand.
  5. Sessions and routes: secondary.
  6. Compatibility and diagnostics: collapsed by default.
- A new user should understand purpose, readiness, queue, and next action in ten
  seconds.
- An expert should see discovery is not selection or registration; accepted is
  not delivered; progress is not failure; safe restart/version semantics; no
  private identifiers or content.

## Deliverable 1 — English marketing site copy and IA

Provide:

- Page title and meta description.
- Navigation labels.
- First-viewport eyebrow, headline, and subhead.
- A compact authentic message-exchange specimen: two neutral agent aliases, one
  short message, and one honest receipt/state line. This is a marketing
  illustration and must be clearly labeled. Do not present its message content
  as dashboard data.
- Primary and secondary calls to action.
- Ordered page sections with headings, short body copy, and key labels.
- Concise security/trust copy.
- Quickstart intro and the exact six-step command flow above.
- Footer/legal copy.

Keep the homepage concise enough to implement as one static page.

## Deliverable 2 — zh-CN marketing site equivalent

Mirror the English IA and meaning, but localize idiomatically. Keep commands
exact and English. Include the full quickstart command flow. Do not overclaim.

## Deliverable 3 — English dashboard string catalog

Organize strings by the six dashboard panels. Include:

- Headings, eyebrow/summary text, tooltips or helper lines.
- Primary actions and copyable command labels.
- Empty states for no broker, no registered Codex task, no discovered Claude
  session, discovered but unselected, no deliveries, no alerts, and no queue.
- Loading, stale snapshot, and auto-refresh-paused states.
- Success, warning, stalled, incompatible, offline, expired, ambiguous, and safe
  error states.
- Acceptance-versus-delivery explanation.
- Static-snapshot wording and proposed opt-in live read-only wording. Do not
  claim actions mutate anything unless implemented.
- Accessibility labels for exchange direction, status, queue age, and receipt
  history.

Keep enum and code display names stable in English where appropriate.

## Deliverable 4 — zh-CN dashboard string catalog

Mirror deliverable 3 idiomatically. Commands, enums, and safe codes remain
English. Preserve all protocol distinctions.

## Deliverable 5 — README zh-CN intro and Quickstart translation plan

Provide:

- A concise zh-CN README opening: headline, one-paragraph definition, install
  snippet, and unofficial-project note.
- A compact but complete zh-CN Quickstart draft using the six steps.
- A translation-maintenance plan covering English as canonical, stable anchors,
  what remains untranslated, a glossary for discovery, selection, registration,
  acceptance, delivery, receipt, held, stalled, expired, and ambiguous; a
  protocol review checklist; and an update workflow.

Do not translate source-code identifiers or change commands.

## Copy risks and decisions

Call out any phrase whose behavior implementation must confirm, especially live
dashboard, stall notices, route reselection after restart, actions, queue age,
and terminal receipt delivery. Offer conservative fallback wording where
needed.

Write the result as a complete Markdown artifact ready for editorial review.
