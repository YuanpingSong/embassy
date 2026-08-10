# Embassy Marketing Site — Product Requirements

Owner: PM. Status: the launch-floor site shipped with v1.0.0 and is live at `https://yuanpingsong.github.io/embassy/` (source in `site/`); this document governs the designer-led rebuild. It specifies what the site must say, prove, and accomplish — the visual system is yours. Where imagery and color are concerned, the working truth is the system you already hold (`docs/BANNER-BRIEF.md`, the shipped dashboard tokens in `assets/live-dashboard/app.css`, and the arch-era logo set in `assets/embassy-logo/`); `docs/DESIGN.md`'s honesty rules remain canon, its imagery sections are historical. Product truth traces to `README.md` and `docs/` — when this document and the README disagree, the README wins and this document has a bug.

## 1. Mission

The site is the product's front door and its only marketing surface. It has one job with two halves: make a developer who runs both Claude Code and Codex *want* this within thirty seconds, and get them to a running `embassy serve` within five minutes. Today's page reads as honest documentation; the rebuild should read as a product — as considered as the engineering it fronts — without surrendering a word of the honesty. Be ambitious: this page is allowed to be the most beautiful thing the project ships. It is not allowed to say anything untrue.

## 2. Audiences and conversion

- **The curious developer** — runs both tools, has felt the copy-paste-between-windows pain, skims. They must grasp *what this is, that it's for them, and what to do next* within ten seconds of landing.
- **The AI-expert skeptic** — arrives ready to catch overclaims. The site converts them by being more honest than they expect: receipts that mean exactly what they say, limits stated before features, the "new input path" warning in plain view.

Conversion paths, in priority order: (1) primary — `npm install -g agent-embassy` / quickstart; (2) secondary — GitHub; (3) tertiary — docs deep-links. One primary action per view; the seal/accent never spends itself on anything less.

## 3. Content requirements

You may restructure the information architecture freely — these are presence-and-hierarchy requirements, not an ordering. Current copy may be rewritten (see §4 for what must survive verbatim in meaning).

- **Hero.** The product in one sentence; the name earning itself (the embassy metaphor is the brand's spine — use it); the two CTAs; and one honest qualifier line (local, single-user, unofficial). The hero must include a *demonstration*, not a decoration: a real-shaped exchange between a named Codex task and a named Claude session, with a receipt. The current "illustrative exchange" vignette is the right instinct executed at floor level — this is the element with the most headroom (see §6).
- **Why.** The three moments of pain/relief (mid-flow question, away-from-desk reply routing, no-plugin discovery). Rewrite freely; keep them concrete and second-person.
- **How it works.** The five operator steps (serve → register → select → send → watch), each with its exact command, copyable. Truth constraint: steps must match the shipped CLI byte-for-byte.
- **Protocol truth.** The site's signature section — keep it, and fix its density. Today these are 100-word documentation paragraphs; the requirement is the same truths in scannable form (the reader should be able to *hold* each truth): delivered ≠ read; queues are honest and never interrupt; restarts drop bodies on purpose; unknown versions fail closed; `embassy serve` opens no network listener (the opt-in live companion is the sole loopback listener); a routed message is a new input path — treat it as untrusted input to its receiver.
- **Quickstart.** Honest requirements first (macOS, Node ≥ 20, exact version pins), then the full command sequence. Must reflect v1.1.0 semantics: only the token-holder can `reply`; conversations are hop-bounded; the other direction needs no Embassy commands at all (native `ListAgents`/`SendMessage`).
- **What's new** *(new)*. A quiet release strip: v1.1.0's headline (routes survive App Server endpoint-generation changes) with a changelog link. Must be cheap to update per release.
- **Dashboard showcase** *(new)*. The live dashboard is the most visual artifact the product owns; show it — a faithful static capture or recreation, labeled metadata-only. Never a fabricated screenshot with invented data: derive from a real dashboard state.
- **The vocabulary** *(new)*. Registration and pairing (the permission model), the ledger (receipts), the pouch (transit), consulates (the roadmap). Today this lives only in the README; it is marketing gold and belongs on the site.
- **For agents** *(new)*. The `embassy-peer` skill: one paragraph, the two `cp -R` install commands, the `$embassy-peer` invocation.
- **Footer.** Docs/architecture/security/contributing links, MIT, the unofficial-project and trademark disclaimer, and the privacy claim ("this site is a static page: it loads no external assets, sets no cookies, and collects nothing") — which must remain *true* (§5).
- **Bilingual.** Full zh-CN parity as a structural mirror (`site/index.html` + `site/zh-CN/index.html`), cross-linked, commands and protocol tokens staying English.

## 4. Truth constraints (hard)

- **No overclaims, ever.** "Delivered" is acceptance, never completion. Nothing implies Embassy reads, understands, or verifies content. "Local" describes the broker and route, not model inference.
- **No fabricated anything** — no invented metrics, testimonials, user counts, company logos, or fake terminal output. The hero exchange must be real-shaped: real command forms, real receipt states, plausible latency.
- **No vendor logos or trade dress**; Claude and Codex appear as names only, with the trademark disclaimer intact.
- **Every command, flag, version pin, and protocol claim** must be correct for the shipped release at publish time, traceable to `README.md`/`docs/`. Version pins appear in exactly one place on the page so a release bump is a one-line edit per language.
- **Message bodies never appear in dashboard imagery** — the dashboard is metadata-only and its portrayal must be too.
- **Limits stated plainly**: macOS-only, single-user, same-machine, bodies dropped on restart by design, the shared-App-Server IAB limitation. Honesty is the conversion strategy, not a compliance footnote.

## 5. Technical constraints (hard)

- **Static files, no build step.** The Pages workflow deploys `site/` verbatim. Whatever you author is what ships.
- **Zero external requests.** Keep the CSP meta (`default-src 'none'; img-src 'self'; style-src 'unsafe-inline'`, extended only as your implementation genuinely requires). System font stacks or self-contained assets only. The footer's privacy claim depends on this.
- **JavaScript is permitted but optional-by-construction**: self-contained, no libraries, and the page must be fully legible and navigable with JS disabled (progressive enhancement for motion and interaction only).
- **Relative asset paths everywhere** — the site serves from a subpath (`/embassy/`). Absolute paths are how tonight's 404s happen.
- **Weight budget**: ≤ 300 KB per page including inline assets (current floor: ~25 KB; spend the difference deliberately — the hero demonstration and dashboard showcase are worth paying for, decoration is not).
- **Responsive** 360 px through ultrawide; wide content (code blocks, the exchange vignette) scrolls inside its own container, the page never scrolls horizontally.
- **Accessibility**: keep the skip link; visible focus states; contrast at text sizes; `prefers-reduced-motion` honored by every animation.
- **No-slop directive (operator-issued, standing)**: no colored left-accent rails, no gradient-hero clichés, no emoji section markers, no centered-everything symmetry. Tone via wash and type, not ornament.
- **SEO repairs (required)**: fully-qualified `hreflang` alternate URLs; `rel=canonical` on both pages; nav anchors land on real sections with `scroll-margin-top` (today's `#dashboard` lands mid-list); absolute `og:image`/`twitter:image` (already correct — keep).
- **Known defects the rebuild must clear**: the favicon is the tent-era mark while the logo set is arch-era — reconcile under your system; the duplicated inline stylesheet across the two language files is acceptable only if the copies stay byte-identical (an external shared stylesheet with relative path is also fine).

## 6. Ambitious scope (encouraged, gated)

The operator has asked for ambition, and the designer is trusted with it. Each item is gated only by §4 truth and §5 constraints (self-contained, no build, degrades gracefully):

- **The hero exchange, animated.** A replayed real exchange — message crossing, receipt settling from `queued` to `delivered`, the `conv_` token returning to the sender — as the page's one orchestrated moment. This is the product demo and the brand statement in one element.
- **Receipt states as interaction.** The protocol-truth section could let a reader touch each terminal state (delivered / unconfirmed / ambiguous / expired) and see its exact meaning — the register that doesn't flatter, made tactile.
- **A dashboard moment.** The five-tab live view presented as an artifact worth wanting — the showcase from §3 elevated to a set piece.
- **The arch as architecture.** If the gate/arch mark wants to organize the page (thresholds, crossings, section transitions), that is on-brand — an embassy is a building you walk into.

Deliver the ambitious version; if any element fights the weight budget or the no-JS floor, ship the quiet version and note what was cut.

## 7. Quality bar

- **The ten-second test**: a first-time visitor states what Embassy is, that it's for them, and their next action within ten seconds. Test at 360 px and desktop.
- **The skeptic's audit**: every protocol claim on the page verified line-by-line against `README.md`/`docs/` by the PM before landing; any claim that needs a caveat to be true gets the caveat or gets cut.
- **Two adversarial review rounds** before shipping (canon process): once through the new-user lens, once through the AI-expert lens.
- **Parity check**: zh-CN structurally mirrors en; neither language ships a section the other lacks.
- **Delivery format**: updated `site/index.html`, `site/zh-CN/index.html`, and any assets under `site/`, as static files meeting §5. PM lands via the linear cherry-pick flow (dev → main). Two to three IA/hero directions early beat one polished direction late — checkpoint with the PM before full execution of both languages.
