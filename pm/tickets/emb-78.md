---
id: emb-78
title: Fresh-machine setup dogfood — boot-mandatory legacy providers, error opacity, install-channel gaps
kind: bug
size: 3
status: draft
release: v1.8
updated: 2026-08-16
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
