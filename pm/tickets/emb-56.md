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