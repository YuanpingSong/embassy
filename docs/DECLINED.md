# Declined decisions

This file records what Embassy has considered and chooses not to build, so
the product documents its refusals as carefully as its features. Changing a
decision here means addressing its reason, not ignoring it.

- **Native Claude sending advertisement or helper process** — Declined.
  Sending is one `embassy send` command from the calling session; Embassy
  installs no helper or advertisement process into Claude's native agent
  list. The native socket is used only to wake the receiving session.
- **Shell-peer registration, tokens, mailboxes, or an `await` command** —
  Declined. Receiving is native and never polled; an agent that cannot be
  woken natively is not an endpoint.
- **Automatic forwarding of Codex output as a reply** — Declined. A reply is
  an explicit `embassy send --conversation` from the recipient, so every
  message has one deliberate author and one identity-bound receipt.
- **A native provider queue or replay of an uncertain write** — Declined.
  Ordinary Codex work waits in Embassy's own bounded queue until an immediate
  idle observation; an armed or accepted write whose outcome is unknown is
  recorded as ambiguous or unconfirmed and never replayed, because the App
  Server response cannot distinguish a steer from a fresh turn.
- **`turn/interrupt`, answering approvals, or changing a task's sandbox or
  approval policy** — Declined permanently. `STEER:` uses only the accepted
  operation's `turn/steer` at a safe tool-call boundary; Embassy never forces
  delivery by interrupting a generation or acting on the user's behalf.
- **Codex write activation from read probes** — Declined permanently.
  Discovery metadata (initialize, thread listing, status) never grants
  `turn/start` authority; every delivery resumes and attests the exact task
  immediately before the write.
- **Codex write-attestation probe threads** — Declined. Creating probe
  threads has visible side effects in the user's Codex app, so `embassy check`
  exercises only broker loopback and is documented as not a provider readiness
  proof.
- **Dashboards, watch streams, activity journals, and general counters** —
  Declined. `status` and `tui` render one closed, body-free snapshot; recent
  terminal evidence is bounded by count, bytes, and time and is not an
  analytics feed.
- **Persisted remote route mirrors and multi-hop routing** — Declined. Remote
  catalogs are bounded memory-only observations; named and exact routing always
  asks the owner over a directly configured SSH login.
- **A separate federation identity mode** — Declined. The plain same-user SSH
  login is the trust boundary; a forced command, per-node key, or host-label
  attestation would add configuration without changing who is trusted.
- **3.x or unknown-schema migration or converter** — Declined. Only the
  immediately previous 4.x schema is read forward; every other schema refuses
  before mutation, and rollback is the preserved old binary with its
  untouched old state.
