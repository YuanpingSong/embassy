---
id: emb-72
title: De-ceremony 66C+66D — presentation and docs truth sweep
kind: docs
size: 2
status: draft
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

**Budgets**: size 2 combined. Sequenced after emb-70/71/68 so every sentence
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
