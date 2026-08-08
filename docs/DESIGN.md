# Embassy Design System — "Porcelain & Seal"

Canon for every user surface: marketing site, dashboard, README visuals, mark,
and social imagery. One token system; no surface invents its own values.
Agreed jointly (PM + engineering) 2026-08-08.

## Idea

Embassy's brand is the **receipt** — the seal that records a message
crossing a boundary and how delivery settled. (A settlement record, not
cryptographic proof: today `delivered` can mean the receiving App Server
accepted the turn, not that the model consumed or completed it. Copy on any
surface must never claim more than this.) The visual world is a light, unhurried diplomatic
register: porcelain paper, near-black ink, hairline rules, and exactly one
decisive color — seal red. Abstract, artistic, calm. No buildings, no flags,
no vendor colors, no circuit-board "AI" imagery.

## Tokens

### Color

| Token | Value | Use |
| --- | --- | --- |
| `--porcelain` | `#f8f4ec` | Page ground |
| `--porcelain-raise` | `#fffdf8` | Cards, panels |
| `--ink` | `#231f1a` | Primary text |
| `--ink-soft` | `#6d6558` | Secondary text |
| `--rule` | `#e4dccd` | Hairlines, borders |
| `--seal` | `#b3382c` | Brand + one primary action per view — the cinnabar seal. **Never a state color.** |
| `--jade` | `#557f68` | Healthy / delivered / positive states |
| `--ochre` | `#a8842f` | Waiting / queued / in-progress states |
| `--codeblock` | `#262019` | Terminal code blocks only — the one deliberate dark exception |

Rules: cinnabar never decorates and never signals any state — it is the brand
and the single most important action on screen. **There is no second red.**
Failure is carried by SHAPE (the broken seal) rendered in `--ink`, never by a
red that would compete with the brand at small sizes. Jade and ochre are
semantic only and never used decoratively. Dark-mode variants are NOT provided in v1 —
the light porcelain world is the committed identity (paint every ground
explicitly; never inherit host backgrounds).

### Type

| Role | Stack | Treatment |
| --- | --- | --- |
| Display | `"Iowan Old Style", "Palatino Nova", Palatino, Georgia, serif` | Large, tight-tracked (−0.01em), `text-wrap: balance` |
| Body | `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, sans-serif` | 16–17px / 1.65, max width 65ch |
| Utility | `ui-monospace, "SF Mono", Menlo, Consolas, monospace` | Commands, receipts, timestamps, stats; `font-variant-numeric: tabular-nums` |
| Label | Body stack | 11–12px, uppercase, letter-spacing 0.14em, `--ink-soft` (or `--seal` for the active section) |

### Space & structure

- Base unit 8px; section rhythm 72–96px on the site, 24–32px on the dashboard.
- Hairline rules (`1px solid --rule`) separate; whitespace groups. Prefer
  asymmetric editorial layouts over centered symmetry on the site.
- Cards: `--porcelain-raise`, 1px `--rule` border, radius 10px, no shadows
  heavier than `0 1px 2px rgb(35 31 26 / 4%)`.
- Wide content (tables, code) scrolls in its own container; the page never
  scrolls horizontally.

## The mark

An abstract seal: a circle holding two facing arcs that shelter a sealed
center point — the parentheses of a meeting. **No diagonal strokes anywhere**
(diagonals collapse into an error X at small sizes), **never radial from the
hub** (reads as a clock), **nothing detached below center** (reads as a
face). Two parties, one meeting point. At 20px and below, drop the outer
ring. Sources:

- `assets/mark.svg` — ink line version on light grounds.
- `assets/mark-seal.svg` — solid seal-red disc with porcelain chevrons; used
  for favicon and small sizes (legible at 16px).

Receipt iconography derives from the mark: **delivered** = intact seal
(jade), **queued** = half-drawn seal (ochre), **expired/failed** = broken
seal (ink — shape carries the failure; no red competes with the brand). The
brand cinnabar seal itself never marks a state. No other icon family is
used.

## Site first viewport

Not an illustration with a title: a compact, authentic message exchange —
two named agents, the seal at center, a delivered receipt — showing the
product doing its one thing. Then accreditation/how-it-works, protocol
truth, real dashboard proof, quickstart/security.

## Dashboard information architecture

1. **Exchange board** — Claude selection ↔ queue/pouch ↔ Codex registration;
   broker readiness and the next action inline.
2. **Needs attention** — ordered, actionable, hidden when empty.
3. **In transit** — queue count, oldest wait, and explicit stall state from the
   bounded public snapshot.
4. **Activity ledger** — receipt lifecycle; details on demand.
5. **Sessions & routes** — secondary.
6. **Compatibility & diagnostics** — collapsed by default.

Every alert pairs the state with the exact next command. Raw data lives
behind the questions, never in front of them. Review lenses: a new user must
understand purpose / readiness / queue / next action within 10 seconds; a
protocol expert must verify discovery ≠ selection ≠ registration,
accepted ≠ delivered, progress ≠ failure, no private data, no overclaims,
and correct ambiguity/restart/version semantics.

## Localization

Runtime dashboards, CLI guidance, and native gateway notices render from
closed, parity-tested `en` / `zh-CN` catalogs. Commands, JSON keys, enums,
aliases, protocol tags, and safe codes stay English. English remains canonical
for security meaning. The marketing site and README ship parallel locale
artifacts rather than changing the runtime protocol.

## Review gate

Every batch built under this system passes two adversarial reviews — a
new-user lens and an AI-expert lens — before it ships.
