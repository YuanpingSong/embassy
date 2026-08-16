---
id: emb-69
title: DeepSeek and Grok Build as routable ACP providers
kind: normal
size: 3
status: landed
release: v1.7
updated: 2026-08-16
---

## Binding

**Why**: v1.7's headline — DeepSeek routable — under emb-65 PM ruling B, plus
the ACP-universal proof the founder named (Grok Build, native ACP, on the
checksummed registry).

**Deliverable**: two provider definitions over the emb-67 client. (1)
DeepSeek: launch spec targeting the LOCAL harness checkout's dsh-acp (the
npm artifact is unspawnable: no bin, workspace:^ peers; emb-56's attested
harness home locates the checkout); registration under the `dsh-` prefix;
the lane's end_turn receipts settling **unconfirmed / ACP_OUTCOME_COARSE** per the emb-66 amendment (end_turn from this adapter proves nothing; claiming delivered would violate the ambiguity law; sound cancelled stays cancelled) — the adapter's
spec-violating stop-reason collapse (aborted/blocked/error → end_turn) is
adapter-side and unrecoverable client-side; an upstream issue filed for the
collapse and for settlement-on-idle. (2) Grok Build: launch spec from the
ACP registry entry (npx @xai-official/grok@<registry-pinned> agent stdio —
note the registry pins the alpha dist-tag; use the registry's exact pin);
capabilities read at connect time per R2, degrading honestly — its
stop-reason fidelity is unverified read-only and needs no advance
verification by design. Both lanes: live proof = one real send round-trip
each, token spend surfaced in the release record (first DeepSeek and first
Grok tokens).

**Budgets**: size 3. Sequenced after emb-68. No write-authority concept
exists post-de-ceremony; routing a message to a provider starts a turn on it
— that IS the product, founder-directed for both providers by name.

## Pre-cut contest + three rulings (2026-08-16)

Engineer verified the landed seams before writing anything and surfaced three
real gaps; PM verified the machine before ruling and CORRECTED THIS TICKET:
no deepseek-harness checkout exists locally (DSH_HOME unset, ~/.dsh absent) —
the binding's "attested harness home locates the checkout" assumed an
install; the primary acceptance behavior is therefore the honest DEGRADED
path. DRILL DEPENDENCY (founder-side): the v1.7.0 DeepSeek live proof
requires the founder to clone/install the harness and configure its own
credentials; otherwise the release live-proves Grok only and DeepSeek's
proof lands when installed. Grok's proof needs no install (registry npx pin).

RULED: (1) registration lifecycle = config-declared acpProviders section,
boot-registered PM-bound aliases (defaults dsh-main@this-mac,
grok-main@this-mac), lazily-spawned child on first dispatch, one session per
route, stale lifecycle + bounded backoff on death/absence; NO new
control/CLI surface (pairing = emb-68's generic arm). (2) DSH_HOME (default
~/.dsh) IS the harness checkout root; launch argv config-overridable,
default ["pnpm","--dir",<home>,"run","demo:acp"] — emb-61's exact evidence,
the stable public entry; internals not encoded. (3) file window approved as
proposed + config.ts (+test); deepseek-detect.ts is a conversion (version
machinery dies, attested-home resolver survives). E3 stands; contest-before-
cut if the remainder map disagrees. Ledger: 13/13 (all three gaps real).

## Contest #14 (budget, pre-edit) — GRANTED

Remainder map before first edit: the Ruling 3 detector conversion mandates
~250 lines of delete/replace (obsolete version observer + its three tests)
that the E3/500 figure never priced; smallest production shape ~230–280
added source + ~180–230 added tests. Ceiling revised to ≤800 changed lines
total (adds+deletes), behavior level and window unchanged, actual counts at
freeze. Cap-from-remainder-map rule working as designed on its third use.
Ledger: 14/14.

## Landed (2026-08-16)

SLICE READY from lane /private/tmp/emb69-freeze at exact tip a0ec524;
+556/−241 = 797 changed (≤800), 10 files, one concept. Freeze-note anomaly
resolved: the lane's "unrelated histories" was an artifact of its temp-lane
provisioning — PM verified 60848a1 is an ancestor of both branches in the
real repo; the engineer's remedy (byte-identical base-blob proof + transplant
to the true tip) was sound. PM review: COARSE mapping exact (deepseek
end_turn → unconfirmed/ACP_OUTCOME_COARSE, grok delivered, cancelled stays);
backoff ladder verbatim (250/500/1000/2000/5000); config defaults boot-
register dsh-main/grok-main under the prefix table with launch defaults in
reviewed server assembly (Grok = @xai-official/grok@1.0.5 agent stdio, the
registry's exact pin, test-asserted); DeepSeek launch = converted
deepseek-detect resolver (DSH_HOME/~/.dsh root, pnpm --dir <root> run
demo:acp only); credential sentinel test plants a real 0600 secret and
proves it unread; acp-provider.ts is 212 lines. PM gate: isolated worktree,
check 738 pass / 0 fail (+3 net tests), soak 1/0, every accepted message
settled exactly once. Landed as one commit from the frozen patch
(SHA 53acb2d8…). v1.7's CODE IS COMPLETE — emb-72 surfaces remain.

## Post-release launch-definition intel (founder + registry, 2026-08-16)

Founder: the harness runs as `npx @deepseek-ai/dsh web`. Registry verified:
@deepseek-ai/dsh@0.1.0-rc.6 is PROPERLY published (bin present, 61 real
deps, zero workspace: specifiers, coherent dist-tags) — the unspawnable
defect was the dsh-acp ADAPTER package only. Tarball read: the CLI exposes
only the `web` subcommand — no acp/stdio server mode in the published
package — so the checkout-pnpm launch definition stands. WATCH ITEM: when
upstream ships an ACP mode in @deepseek-ai/dsh, the launch definition
upgrades to an npx package launch (one config default change) and the
DeepSeek lane loses its checkout dependency. `~/.dsh` as user-data is
consistent with the web-mode usage.
