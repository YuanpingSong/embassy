---
id: emb-89
title: v2.0 R3 — host identity cut: mandatory nodes.json, delete EMBASSY_HOSTS and every this-mac default
kind: normal
size: 3
status: landed
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

## Gate rulings (v1 freeze, 2026-08-17)

Independent gate: SHA 8395b412; src 223/≤235 net +1, tests/docs 220/≤220,
total 443/≤500, all reproduced; per-file itemization matches numstat;
554/554. Adversarial: GO — single identity source with zero surviving
fallbacks; refusal purity verified on empty AND established installs
(fires ahead of lease acquisition); host rename refuses reversibly with
state intact; screen asserted exactly both locales with a private-message
canary. Taste: land-with-corrections — do-not-golf passed emphatically
(TWO this-mac attestation bypasses deleted, new helper host-mismatch
refusal added, literal checks degraded to pattern not typeof); rider
satisfied, all 16 src files identity seams, no drive-bys.

**Record correction**: taste's "untracked debris" finding
(test/zz-emb89.test.ts in the gate worktree) was the adversarial
reviewer's own attack suite left in shared gate infrastructure — PM
cleaned it; the engineer's "no untracked files" freeze claim stands; the
ceiling-truncation inference is withdrawn.

**Rulings**:
1. store.ts:2793 ownership-guard relaxation (adopt pre-existing state dir
   containing exactly nodes.json) RETROACTIVELY AUTHORIZED — design-
   forced by the documented boot order — CONTINGENT on test coverage:
   the guard must be exercised both ways (tolerates only-nodes.json;
   refuses any other pre-existing entry).
2. CORRECTION BUNDLE before landing: (a) the guard tests above; (b) a
   negative test for the new CLAUDE_ROUTE_MISMATCH host check
   (claude-helper.ts:93); (c) the refusal hint must NAME the state
   directory path (exact-fix standard; both locales); (d) delete the
   three stale configured:true fixtures (gateway-cli.test.ts:2010, 2028,
   2050). Optional, engineer's call: dedupe the "nodes.json" literal.
3. Ceilings for the bundle: tests/docs raised to ≤260 (the bundle is
   test-heavy by construction — this is not an emb-89 third escalation,
   it is PM-added scope); src ceiling unchanged 235 (223 + ~6 copy).
4. Docs line for the pre-existing de-federation sharp edge (remove a
   peer → mirrors persist → reset required) — one sentence in the
   federation section, ride this bundle.

Adversarial notes recorded: de-federation edge (pre-existing, not a
regression), error-ordering nit (cosmetic, declined). Gauntlet-file
entries: bare-HOME boot opacity; de-federation reset severity.

## Landing (v2 freeze, 2026-08-17)

LANDED on public main 788a6f3. v2 bundle verified: SHA 5df5d0ec; src 224
changed net +2 (≤235); tests/docs 245 (≤260); 555/555 in gate AND landing
trees. Bundle delivered all five ruled items: ownership guard proven both
ways, CLAUDE_ROUTE_MISMATCH negative test at the production helper, state
directory path named in the hint (EMBASSY_STATE_DIR/XDG_STATE_HOME aware),
stale mocks deleted, de-federation edge documented in both locales.
Concept count stayed exactly one. Two slices down, two to cut: emb-90
(control cleanup), emb-91 (send verb), then v2.0.0 assembles.
