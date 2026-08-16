---
id: emb-56
title: DeepSeek harness monitor-only attestation (Shape A)
kind: normal
size: 3
status: dispatched
release: v1.7
updated: 2026-08-16
---

## Binding

**Why**: founder wants Embassy to see a local DeepSeek harness. Shape A from the emb-54 report: a compatibility surface only — detected, probed read-only, rendered quarantined. Never a routable provider; avoids all three closed 2-provider product types.

**Depends on**: emb-55 (optional surfaces) landing first.

**Promises:**
1. A local `dsh` install is detected via bounded read probes (installation, harness home; runtime-launch and session-list probes per the design in emb-54 — wire method names must be verified first, report gap 1).
2. The attestation records honestly (`incompatible`/quarantined under current prerelease versioning — that is correct, not a bug) and renders on the dashboard as detected-and-quarantined with a reason.
3. Zero routing, pairing, or write paths; the provider registry is untouched.
4. Probes never read, log, or echo `~/.dsh/.credentials.yaml` or any credential material (explicit test).
5. Absent `dsh` (the overwhelmingly common install) costs nothing: no probe spawns, no dashboard noise.

**Budgets**: size 3; concepts: one ("deepseek surface"). Tests: the promises, plus one manual check — render the dashboard with and without a local dsh install.

**Non-goals**: no write attestation (emb-49/founder); no version-pattern changes (emb-57); no ACP integration (declined for v1.6, see emb-54 ruling).

## Background (hypotheses — re-verify)

emb-54's completion report is the evidence base: probe table in §3, line budget in §4 (~550-650 lines pre-split), `IncompatibleGatewayProvider` (providers.ts:454-585) as the template, surface/identity coupling at providers.ts:467 to decouple. JSONL session files default to zstd framing — prefer the JSON-RPC path over file tailing.
## Four-point contest and rulings (2026-08-16, all accepted)

**1. Window APPROVED as proposed** (15 files: new deepseek-detect.ts + compatibility/service/server/
dashboard surfaces + six test files). providers.ts and types.ts stay untouched — the engineer's
read is right that IncompatibleGatewayProvider is identity/routing-coupled and using it would
violate this ticket's own zero-routing promise. emb-54's decoupling suggestion is superseded.

**2. Promise 1 CORRECTED — the PM's ticket lagged the PM's own emb-61 ruling** (written from the
emb-54 report before the transport ruling adopted filesystem + dsh --version only; the native wire
has no session-list method). Corrected promise, replacing the original: detect an installation
without spawning it; if present, perform only bounded Shape A observations of the exact harness-home
root and `<absolute dsh> --version`; never launch a runtime, enumerate sessions, or open JSON-RPC;
record the current prerelease/unparseable version honestly as incompatible/quarantined. Synthetic
tests cover all probes; no real provider read. Process lesson recorded: when a design ruling lands,
sweep open tickets it invalidates — this one wasn't swept.

**3. Observer seam APPROVED**: a narrow CompatibilitySurfaceObserver accepted separately by the
service; adapters project into it; DeepSeek supplies observation/probe data only and never enters
adapters, gatewayProviders, pairing, routing, connectors, or write paths. Startup rejects observers
whose surface is absent from compatibilitySurfaceDefinitions — closing emb-55's carried watch-item
in the same commit, as required. Internal plumbing; the user-facing concept count stays 1.

**4. Absence rendering INTERPRETED**: the neutral "DeepSeek — Not detected" compatibility row IS
the no-noise state (emb-55's promise governs); "no dashboard noise" means no attention item, no
connector, no route, no degradation — never no row.

**Trust contract APPROVED as stated**: PATH-resolve dsh to an absolute candidate; lstat/stat-attest
the executable and exact harness-home root (DSH_HOME or ~/.dsh) for same-user/non-symlink safety
before spawning only `<absolute dsh> --version`; absent resolution returns before any spawn; the
detector never enumerates or opens the home, above all .credentials.yaml.

Budget: size 3 stands with the corrected (smaller) promise set.

## Certified-set ruling (2026-08-16, contest #14)

**Ruling: option (A).** An explicitly empty certified set is permitted for OPTIONAL
compatibility-only surfaces — it is the honest expression of "no build of this surface has ever
been certified." Evaluation then falls through naturally (nothing certified, nothing same-major)
to incompatible; today's prerelease reality surfaces as DEEPSEEK_HARNESS_VERSION_UNPARSEABLE
(declared via emb-55's exhaustive switches, so the compiler enforces the new surface's codes).
The nonempty rule is PRESERVED for required surfaces — Claude/Codex semantics byte-identical.
Public reference fields (testedVersion/supportedMajor) become optional only for empty-set surfaces
and render as unavailable — public snapshot only, nothing persisted, downgrade-safe.

Option (B) REJECTED: a detected-but-non-attested second evidence shape is two kinds of truth about
surfaces — more machinery and less honesty than teaching the one evidence shape to state "never
certified."

**Window expanded**: + src/gateway/types.ts, + src/gateway/dashboard-model.ts. SEAM NOTE: main's
emb-59 lane also holds types.ts (safe-code list only); your hunks (snapshot reference fields) are
disjoint — lanes make this a text merge, and landing order is PM-decided as always.

**emb-57 unaffected**: it still owns whether prerelease can ever climb; empty-set-permitted plus
honest quarantine is compatible with any answer it produces.

**Budget**: size 3 stands; if the honest implementation exceeds 500, report the actual per the
emb-59 ground-truth precedent — expected to fit.
