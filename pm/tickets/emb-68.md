---
id: emb-68
title: N-provider generalization — all-to-all routing, unified native state, from/to-provider surfaces
kind: normal
size: 5
status: landed
release: v1.7
updated: 2026-08-16
---

## Binding

**Why**: founder rulings on emb-61 — all-to-all provider routing (Q7: no
artificial pairing restrictions; per-edge consent stays), ONE unified route
table as the binary's NATIVE state format (Q4 + migration addendum: no
in-binary migration or prune; our own state migrated once by hand;
unparseable state gets the ordinary strict-parse honest error),
from-provider/to-provider on deliveries UI and the reply-hint attribute
(Q1/Q5), `dsh-` registration prefix (Q6), and no naming-based rules —
provider truth comes from the lease-proven route record (Q3).

**Deliverable**: the three closed 2-provider product types generalized to N
providers per the emb-61 part-2 design MINUS everything migration-related:
derived ordered provider pairs (no hand-written unions), the unified route
table as native persisted state, provenance recipient-profile with the
from-provider hint attribute, deliveries UI with from/to provider selectors,
registration prefix enforcement for `dsh-`, and the routing layer accepting
any provider pair that holds a consent edge. Two-provider behavior unchanged
— carried by the emb-61 part-2 proof obligations (exact-wire tests), not
asserted.

**Budgets**: size 5. Sequenced after emb-67 lands its transport seam.

## Contest #12 + four pre-cut bindings (2026-08-16, ruled before any edit)

Engineer produced the required early remainder map from seven read-only
seam passes and contested before cutting. CONTEST GRANTED: addition caps
revised to ≤1,500 source + ≤1,800 tests added (headroom variant, one grant);
deletions unbounded (~2,300–2,970 test deletions mapped, principally
migration + compatibility-shadow suites); binding promise = strongly
net-negative total. Ledger: 12/12.

BINDINGS RULED:
1. Provider universe owned HERE: canonical keys/order ["claude", "codex",
   "deepseek", "grok"] (alphabetical); display names Claude/Codex/DeepSeek/
   Grok Build; ingress prefixes codex-/dsh-/grok- (ingress convention only,
   never provider proof; Claude unprefixed); 12 derived ordered directions.
   emb-69 adds launch/adapter definitions only — no schema reopening.
2. Native state: schemaVersion 2; role-neutral consentEdges (two canonical
   endpoints {alias, provider, ownerLease} sorted by provider order then
   alias; exact binding/host/lease match; distinct providers; reversed dupes
   reject). Old state/pair rows/compat fields = ordinary
   CORRUPT_GATEWAY_STATE, no rewrite (founder no-migration ruling; PM
   hand-migrates the one real state file at upgrade). Runtime TTL/cap
   pruning stays.
3. Consent authority: legacy Claude/Codex pair/unpair arm byte-for-byte +
   strict generic arm {aliases:[a,b], threadAttestation?}; generic pairing
   is an explicit same-user control action (0600 control socket = same-user
   proof); both routes registered/live/same-host/distinct-provider;
   select-claude stays a wrapper.
4. Claude return path owned HERE: helper registration/IPC seam generalized
   to {sourceAlias, sourceProvider} for every process-owned source route —
   an all-to-all edge universe lands together with the routability of its
   claude-bound edges (Q7 honesty). Codex succession APIs stay
   Codex-specific.

Wire-change set + golden preservation list ratified as proposed.

## Landed (2026-08-16)

SLICE READY at lane HEAD b298abb on declared base 9883b24 (= dev tip);
accounting verified to the digit: source +1,500/−3,934 (additions exactly at
the 1,500 cap), tests +1,726/−2,833 (1,726/1,800), 54 files, NET −3,541.
PM review: all four pre-cut bindings verified in the gate tree — (1)
gatewayProviders ["claude","codex","deepseek","grok"] + frozen exhaustive
ingress-prefix table {claude:undefined, codex-, dsh-, grok-}; (2) state
schemaVersion 2 with lease-bound consentEdges and ordinary strict-parse
rejection of old state (the surviving schemaVersion:1 is the succession
journal's own record — different concept, untouched); (3) legacy pair arm
byte-preserved beside the strict generic arm; (4) helper protocol carries
{alias, sourceProvider} with exact-key validation. Provenance envelope
refactored to the frozen recipient-profile table (satisfies-exhaustive) with
sourceProvider/recipientProvider replacing the binary direction and the
additive from-provider attribute. compatibility.ts reduced 474→53 lines
(metadata helpers only); all emb-68 shims deleted. Engineer-side: three R4
adversarial rounds GO with named corrections (owner-lease retention on
pre-teardown replies, non-Claude alias-reuse rejection, Claude-only
available-peer validation, live-only UI pairing candidates); soak caught a
stale test fake exposing retired helper methods — fake corrected, final pair
green. PM gate: isolated worktree at b298abb, check 735 pass / 0 fail
(752→735 = −17 net tests), soak 1/0 (1,200 randomized iterations, every
accepted message terminally accounted exactly once). Landed as one commit
from the frozen patch (SHA 06fdaaed…).

RELEASE RUNBOOK NOTE: at v1.7.0 upgrade time the machine's live state file
(~/.local/state/agent-embassy/gateway-state.json, schema v1) becomes
unreadable by the new binary BY DESIGN. Hand-migration options at drill
time: write the v2 shape from v1 content, or fresh state + re-register +
re-pair (minutes, and exercises the registration paths live). Decide then.
