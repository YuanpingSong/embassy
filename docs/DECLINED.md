# Declined decisions

This file records what Embassy considered and chose not to build, because a
product that documents its refusals is making the same promise its dashboard
makes: the truth over the appearance of completeness. Changing a decision here
means addressing its reason, not ignoring it.

## v1.5

- **Metadata "doctor" view** — Superseded in v1.7.1 after a live split-brain
  incident proved that status and dashboard evidence alone did not name the
  actionable Desktop attachment failure.
- **Consulates (multi-host federation)** — Deferred indefinitely because
  Embassy is deliberately one user, one machine.
- **Codex write-attestation probe** — Creating probe threads has UI side effects
  in the user's Codex app, so this needs its own design pass; it is a v1.6
  candidate, not declined forever.
- **Codex write activation from read probes** — Declined permanently because
  initialize/thread-list evidence never grants `turn/start` authority.
- **Automatic re-anchor promises in alerts** — Superseded in v1.8 when Codex
  endpoint re-anchoring was removed. The dashboard still states only current
  operation facts, never hoped-for recovery.
- **Cosmetic backlog held out of v1.4/v1.5** (stale `live-*` state-directory
  sweep; dashboard `GET /?query` → `404`; leading-zero port parse) — Correctness
  and honesty shipped first; these wait without shame.
- **Cross-layer launcher-banner provenance policy** — Deferred from CO #39
  because a parser-only patch would have been false; the honest fix spans
  server/provider classification.
- **Claude endpoint-generation deleted-as-churn via constant sentinel** —
  Superseded by native state schema 3, which removed persisted endpoint
  generations instead of adding another compatibility sentinel.
- **Native stall-notice prose kept one hop from the remedy** — The native
  notice states when queued mail arrives and points onward; the dashboard owns
  the full remedy prose.

## v1.7.1

- **Automatic Desktop relaunch after Codex attachment failure** — Declined
  because relaunching can terminate or replace the user's open Desktop windows;
  Embassy diagnoses the condition and prints the exact opt-in remedy instead.
