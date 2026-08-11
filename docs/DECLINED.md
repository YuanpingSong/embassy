# Declined decisions

This file records what Embassy considered and chose not to build, because a
product that documents its refusals is making the same promise its dashboard
makes: the truth over the appearance of completeness. Changing a decision here
means addressing its reason, not ignoring it.

## v1.5

- **Metadata "doctor" view** — A new diagnostic surface does not belong in a
  simplification release; status and the dashboard already carry the evidence.
- **Consulates (multi-host federation)** — Deferred indefinitely because
  Embassy is deliberately one user, one machine.
- **Codex write-attestation probe** — Creating probe threads has UI side effects
  in the user's Codex app, so this needs its own design pass; it is a v1.6
  candidate, not declined forever.
- **Codex write activation from read probes** — Declined permanently because
  initialize/thread-list evidence never grants `turn/start` authority.
- **Automatic re-anchor promises in alerts** — The dashboard states what the
  broker can prove, never what it hopes.
- **Cosmetic backlog held out of v1.4/v1.5** (stale `live-*` state-directory
  sweep; dashboard `GET /?query` → `404`; leading-zero port parse) — Correctness
  and honesty shipped first; these wait without shame.
- **Cross-layer launcher-banner provenance policy** — Deferred from CO #39
  because a parser-only patch would have been false; the honest fix spans
  server/provider classification.
