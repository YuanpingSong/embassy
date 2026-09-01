---
id: emb-91
title: v2.0 R4 — one send verb: `embassy send --from --to`
kind: normal
size: 1
status: dispatched
release: v2.0.0
updated: 2026-09-01
---

## Binding

**Why**: emb-87 slice 4, the last cut of the v2.0 charter. The CLI
ships two directional send verbs (`send-to-claude`, `send-to-codex`)
whose direction is fully determined by the endpoints themselves — the
gateway resolves routes by alias and provider, so the verb split is
ceremony. Single-user product, breaking window open.

**Deliverable**: one `embassy send --from <alias> --to <alias>` verb;
the gateway derives direction from the resolved endpoints.
`send-to-claude` and `send-to-codex` are REMOVED — no aliases, no
deprecation shims, no compat arm (the emb-90 precedent: delete end to
end). Reply/await/delivery-status are untouched. Help copy, SKILL.md,
README (en/zh), site quickstart, and GATEWAY-ARCHITECTURE update to the
single verb — every surface the wave just made truthful stays truthful.

**Riders folded in (release riders, priced here because this slice
owns the CLI/help surface anyway):**
1. `peer-stdio` appears in `--help` (it is a shipped verb documented in
   CONFIGURATION.md and absent from help — gauntlet finding).
2. README.md:227-region: kill the stale "federation is deliberately
   disabled in v1" claim (+ zh-CN mirror) — federation shipped in v1.9.
3. CHANGELOG v2.0.0: add the send-verb break under Removed and the
   emb-88 token/busyPolicy narrowings line (retroactive-authorization
   note from the emb-88 landing).

**Caps**: E1-2; src ≤60 changed (measured-remainder rule — contest with
a map if the coherent cut disagrees); tests ≤120; docs itemized. Zero
new concepts. Base = main AFTER emb-97 lands (emb-97 owns cli-copy
files; this slice touches help copy — sequential, no parallel lanes).

**Acceptance**: (1) `embassy send` routes both directions, verified by
execution against a real broker (claude→codex and codex→claude); (2)
the old verbs are refused as unknown commands; (3) no remaining
reference to the deleted verbs in any shipped doc, help string, site
file, or skill (grep-clean, historical CHANGELOG exempt); (4) the site
and README quickstarts still EXECUTE end-to-end with the new verb (the
emb-93 standard: quickstarts are run, not read); (5) full check + soak
green; (6) per-locale parity on every touched copy/doc surface.

**Gate**: mech + targeted adversarial on the direction-derivation only
(mis-routing = consent violation; everything else is deletion + copy).
