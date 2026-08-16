---
id: emb-72
title: De-ceremony 66C+66D — presentation and docs truth sweep
kind: docs
size: 5
status: landed
release: v1.7
updated: 2026-08-16
---

## Binding

**Why**: batches 66C and 66D of the accepted emb-66 design — the surfaces
follow the final model, so this lands LAST in the de-ceremony sequence.

**Deliverable**: (1) presentation sweep (66C, E3/R2, ≤500 total): dashboard
static/live/copy stripped of tier/probe/writesCovered/certification
vocabulary in both languages, replaced by the best-effort truth (route
staleness, connector health, last safe code, provider-local degradation).
(2) Docs/site/skill sweep (66D, E3/R1, ≤500 total): AGENTS/SECURITY/README/
config/architecture/site/skill text rewritten to the best-effort positioning
— what a release was tested with (the offline matrix) vs what runtime proves
(this connection, this route, this correlated operation). Historical release
notes stay historical; v1.7's notes record the removal.

**Budgets**: size 5 (repriced from 2 when the founder upgraded the scope to a full refresh — the bilingual site re-story through the content pipeline is real work, not a sweep). Sequenced after emb-70/71/68 so every sentence
describes shipped reality.

## Scope upgraded: refresh, not just truth sweep (founder, 2026-08-16)

The founder explicitly directs that the dashboard and the marketing site get
REFRESHED for v1.7, beyond scrubbing stale vocabulary:

- Dashboard: present the four-provider reality as a first-class view —
  provider rows for Claude/Codex/DeepSeek/Grok Build, from/to-provider
  deliveries filtering (lands in emb-68's UI work; this ticket makes the
  whole surface coherent around it), best-effort status language (route
  staleness, connector health, last safe code) in both languages.
- Marketing site: tell the NEW story, not a patched old one — Embassy as an
  N-provider agent gateway over open standards (ACP), best-effort honesty as
  the positioning ("what a release was tested with" vs "what this connection
  proves"), DeepSeek + Grok Build as shipping providers. Both languages;
  site prose follows the established content pipeline (docs/DESIGN.md canon,
  content-writer agent, English canonical, zh-CN last, adversarial review
  rounds per the standing site norm).

Forward note: the site and dashboard refresh AGAIN at v1.9 (the multi-node
single pane of glass is both a headline dashboard evolution and the site's
next story beat) — recorded here so neither release ships surfaces that
describe the previous one.

## Landed (2026-08-16, two halves)

swe3 half (6fa4b81): 20 files, +236/−397 = 633 changed (66C 172/500,
66D 461/500, zero concepts); four-provider rows first-class even when
optional routes absent; all 12 direction labels from the bilingual catalog;
PM gate 738/0 + independent vocabulary sweep — the only two hits are
DISAVOWALS ("does not create a compatibility tier"), zero surviving
certification claims confirmed. Soak skipped with justification (R2/R1
surface work, full check green).

Site half (e20f0f5): PM content pipeline — opus draft with full claim-
provenance notes (every claim mapped to ticket/source/matrix; the shipped
page's unsourced latency claim removed; new #providers band from existing
classes only; #protocol rebuilt around tested-with vs runtime-proved with
the COARSE receipt as a selling point). PM review corrected one
untrue-at-publish claim in both languages (upstream issue "filed" →
receipt-stays-honest phrasing; filing remains founder-gated at release).
English canonical; zh-CN translated.

CARRIED FLAGS (drill/release items): (1) assets/dashboard.png re-capture
from the live v1.7.0 dashboard post-upgrade; (2) no CLI send verb names the
new providers — send-to-codex reaches them mechanically; the site stops at
`embassy pair` deliberately; generic `embassy send` verb = v1.8 rebuild
item; (3) ACP routes are not advertised into Claude's native ListAgents —
CLI/reply-hints are the paths; v1.8/v1.9 consideration.
