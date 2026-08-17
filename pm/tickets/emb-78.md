---
id: emb-78
title: Fresh-machine setup dogfood — boot-mandatory legacy providers, error opacity, install-channel gaps
kind: bug
size: 3
status: landed
release: v1.8.0
updated: 2026-08-17
---

## Binding

**Why**: founder attempted a fresh Embassy setup on a new dev machine
(m5dev, macOS arm64) and hit an opaque INTERNAL_ERROR. PM dogfooded the full
path live over SSH. Five findings:

1. **Both legacy providers are boot-mandatory** — v1.7.1 refuses to boot
   without a home-resident Claude launcher AND a resolvable managed Codex
   standalone layout, while DeepSeek/Grok absence degrades gracefully. This
   violates the best-effort contract ("mere absence degrades only that
   provider"). A fresh machine cannot run Embassy at all until BOTH are
   fully installed. FIX: claude/codex absence at boot = degraded provider +
   honest connector code, broker boots. (emb-77's stateless activation
   already removes the codex boot resolution; the claude half needs the
   same posture.)
2. **CLI error opacity**: cli.js's serve catch discards the exception —
   the founder saw INTERNAL_ERROR; the actual errors were a raw ENOENT
   (lstat ~/.local/bin, escaping unmapped) then MANAGED_CODEX_UNAVAILABLE
   (a BridgeError that STILL rendered as INTERNAL_ERROR — the serve-path
   safe-code allowlist misses transport codes). FIX: map all BridgeError
   codes on the serve path + one bounded detail line (code + path-free
   hint); a raw ENOENT on a default path must become a named condition.
3. **Homebrew Claude Code is unsupported and unnamed**: the cask
   (/opt/homebrew/Caskroom/claude-code@latest) fails
   CLAUDE_EXECUTABLE_OUTSIDE_HOME (honest code, no remedy named).
   EMBASSY_CLAUDE_BIN override exists but is undocumented and cannot
   satisfy the home rule. DECISION QUEUED: allow explicitly-configured
   overrides outside home iff full ownership/mode attestation passes
   (operator config = same-user consent; on Apple Silicon /opt/homebrew is
   user-owned), or keep the rule and NAME the remedy (official installer)
   in the error.
4. **pnpm install resolved agent-embassy@1.5.0** from stale registry
   metadata (three releases old, certification-era boot gates). Docs must
   recommend an explicit version or `npm i -g`; also note PNPM_HOME PATH
   setup for non-interactive shells.
5. **m5dev-specific**: a ghost codex daemon reports alreadyRunning
   (appServerVersion 0.145.0) while its named standalone layout does not
   exist on disk — Embassy's MANAGED_CODEX_UNAVAILABLE is honest; the
   doctor should detect layout-missing-but-daemon-claims-running.

README prerequisites patched same-day (see commit). Items 1-3 ride v1.8
(1 partially lands with emb-77); item 5 extends the doctor.

## Proven fresh-machine recipe (m5dev, live, 2026-08-16 night)

1. Claude Code: curl -fsSL https://claude.ai/install.sh | bash (in-home
   layout; Homebrew cask will NOT attest).
2. Codex: curl -fsSL https://chatgpt.com/codex/install.sh | sh, then
   codex app-server daemon start (daemon start alone does NOT provision the
   standalone layout; unmanaged ghost servers must be killed first — the
   doctor should detect "running but not managed").
3. Embassy: npm i -g agent-embassy (pnpm users pin the version; PNPM_HOME
   PATH note applies).
4. Skills: cp -R <pkg>/skills/embassy-peer into ~/.claude/skills/ and
   ~/.codex/skills/.
Result on m5dev: broker healthy, four connectors (deepseek honestly
degraded), ACP routes registered. Second network node live — v1.9 ground
truth acquired en route.

## Resolution (2026-08-17) — absorbed, all five findings closed

Never dispatched as its own slice; every finding landed elsewhere:

1. Boot-mandatory legacy providers — CLOSED by v1.8.0: launcher/version
   authority deleted entirely, Codex delivery stateless; claude/codex
   absence now degrades that provider only, broker boots.
2. CLI error opacity — CLOSED across v1.8.0–v1.9.5: the rebuilt serve
   path renders named codes (every failure in the v1.9 drills surfaced as
   one: GATEWAY_STATE_CONVERSION_REQUIRED, CORRUPT_GATEWAY_STATE,
   GATEWAY_INSTANCE_IN_USE); the raw-ENOENT class on the converter
   recovery path was typed in v1.9.5 (emb-85 N1).
3. Homebrew Claude decision — OVERTAKEN by deletion in v1.8.0: any
   install channel works, EMBASSY_CLAUDE_BIN removed; the queued
   override-attestation decision is moot.
4. pnpm stale-metadata + PATH docs — CLOSED same-day: README
   prerequisites rewritten (explicit version pin, PNPM_HOME note); the
   non-interactive-PATH remedy (~/.zshenv) is now proven on BOTH install
   channels (m5dev pnpm, this-mac nvm — emb-86 drill).
5. Ghost daemon detection — CLOSED by v1.8.0: doctor gained
   managed_layout_missing, exactly this finding.

The proven fresh-machine recipe above remains the canonical setup
reference; superseded only by README updates since.
