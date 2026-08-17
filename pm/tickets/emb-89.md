---
id: emb-89
title: v2.0 R3 — host identity cut: mandatory nodes.json, delete EMBASSY_HOSTS and every this-mac default
kind: normal
size: 3
status: dispatched
release: v2.0.0
updated: 2026-08-17
---

## Binding

**Why**: emb-87 slice 2 + founder v2.0 charter. The legacy default host
identity ("this-mac", cli/control/config/server literals) is the parked
naming footgun that bit emb-85 live; EMBASSY_HOSTS is a legacy parser
that either does nothing or makes valid nodes.json fail.

**Deliverable**: nodes.json becomes MANDATORY for every install, with
`nodes: []` allowed for local-only; its host is the immutable local
identity from first boot. Missing-inventory refusal prints the exact
one-line fix on the serve screen (error-as-documentation, the emb-88
standard) — no wizard, no auto-generation, no new magic default. Delete:
EMBASSY_HOSTS parser + collision guard; every `hostId ?? allowedHosts[0]`
/ `peerNodes ?? []` fallback; GatewayConfig.hostId/peerNodes optionality
(become required); register-codex host/busyPolicy defaulting and the
public --host escape hatch (host inferred from attested inventory);
internal this-mac in Claude helper protocol/advertisement (canonical host
threaded through). "this-mac" remains a legal explicit host value and
docs example; it stops being a reserved semantic.

**Breaks (intended)**: missing-inventory local-only startup; old control
clients omitting register host/policy; durable routes created under the
default identity (same one-time reset runbook as emb-88 — slices land
adjacent, one operator instruction).

**Caps**: ~45 src lines touched (engineer's own estimate), net within
[-30, +10]; do-not-golf binding; the ~832 test this-mac occurrences are
mostly valid explicit fixtures — no mechanical rename; 80–150 focused
test changes expected. Base = public main 4a69c27. Freeze with SHA;
taste + adversarial at gate (identity is a trust seam).

## Contest ruling (2026-08-17)

Engineer contested the ~45-src-touched estimate (which was their own
emb-87 pre-estimate, ticketed verbatim by PM) with a measured remainder
map from the first coherent cut: the named service/store fallbacks alone
are ~20 sites / ~40 touched lines. GRANTED: src changed ≤175, tests/docs
≤220, overall E3 under 500 changed. Net [-30,+10] becomes an EXPECTATION,
not a hard consequence — do-not-golf logic extends to identity
explicitness. APPROVED: one bounded safe code
GATEWAY_NODE_INVENTORY_REQUIRED for the missing-inventory refusal — the
emb-88 screen pattern; overloading catch-all
INVALID_GATEWAY_CONFIGURATION would either fire the hint on unrelated
config failures or require message-based discrimination. Concept count
for the slice: one.

## Second contest ruling (2026-08-17)

Measured at checkpoint: 203 src changed (net -5, 13 files), excess from
signature/call-site changes forced by making identity required — the
point of the slice, and do-not-golf bars compressing trust seams to fit
a bucket. GRANTED: src changed ≤235 (target ≤225); tests/docs ≤220 and
E3 ≤500 unchanged; net -5 already meets the original expectation. Two
riders: (a) the freeze must itemize src changes per file so taste can
verify every touch is an identity seam, no drive-bys; (b) this is the
LAST ceiling escalation — a third re-price converts to a re-scope
discussion (slice split), not a bump.
