# Delivery semantics

Embassy tracks every accepted message from CLI acceptance through terminal
settlement. This document collects the delivery model in one place: queue
behavior, evidence states, failure handling, retry policy, and the delivery
tokens that let a sender follow a message to settlement. The material is the
authoritative reference for what "delivered" does and does not mean inside
Embassy.

---

- **Queue while busy, with one explicit boundary.** Ordinary messages wait for the Codex task to become available. An exact leading `STEER:` body from Claude to Codex may be admitted to the active turn at its next tool-call boundary. Embassy never interrupts or injects text mid-generation; a cleanly unavailable boundary falls back to the normal queue. At most three steering messages remain queued per route, with the oldest settled as `cancelled/STEER_QUEUE_SUPERSEDED` when a fourth is accepted.

- **Acceptance is not completion.** Initial CLI acceptance returns a conversation token and a delivery token. Successful destination or App Server acceptance settles as `delivered`: toward Codex that is the App Server accepting the turn, toward Claude it is release into the session's native queue — not read, not completed.

- **Evidence has three shapes.** `delivered` means terminal provider evidence was observed. `unconfirmed` means the transport write completed but no terminal native evidence arrived. `ambiguous` means the write outcome itself is unknown. All three are terminal, and neither `unconfirmed` nor `ambiguous` is a retry authorization — inspect the recipient instead, because a resend can duplicate the message.

- **Native failures.** A Claude-originated route or delivery failure settles as native `expired`; its native acknowledgement always retains the normalized safe code in the reason field. The default `merged` notice mode keeps the early stall frame but suppresses the duplicate terminal `<gateway-delivery-diagnostic>` user frame. `verbose` restores that readable diagnostic frame; `quiet` suppresses all gateway-authored user-frame notices, including stalls, while native status and dashboard truth remain. No notice contains a path, native identifier, exception, or message body. `denied` is reserved for a real user or policy refusal and is not authored by Embassy v1. `held` and transport-written are progress, never success.
- **Native held is attempt-then-ack.** For Claude→Codex ingress, Embassy first attempts the exact immediate dispatch. A terminal result observed before the one-second prompt boundary produces only its terminal acknowledgement. Native `held` is sent only when the body actually remains queued (including a busy route or clean provider deferral) or dispatch is still nonterminal at that boundary; the terminal acknowledgement follows later. Claude's rendered “approved and released” notice means only that the paired-consent gateway accepted and released the body to the recipient queue. It does not mean a model read it, and it does not imply human approval.

- **Retries are conservative.** Messages that have not been dispatched remain queued while their route is busy or temporarily unavailable. Re-running `register-codex` replaces a closed or faulted App Server connector and wakes held work when the recovered route is idle. An explicit clean adapter deferral can return the same body to the queue. A confirmed delivery failure settles; an ambiguous write is never retried automatically.

- **Bounded by design.** Bodies, queues, rate windows, deduplication tables, deadlines, hop counts, and transient conversations all have fixed limits.

- **Restarts do not replay text.** Queued and in-flight bodies live only in memory. If Embassy stops before settlement, metadata becomes abandoned, bodies are discarded, and nothing is replayed. A prior Claude binding remains stored but stale; after an authorized complete live discovery, an exact unique stored UUID reactivates automatically; explicit `select-claude` remains the optional fallback. No pending reply or conversation capability survives.

Accepted messages are tracked toward terminal delivery while the broker and provider connections remain healthy. The dashboard distinguishes acceptance, progress, delivery, expiry, failure, ambiguity, and abandonment.

## Delivery tokens

Every accepted `send-to-claude`, `send-to-codex`, and `reply` returns a delivery token: `dlv_` followed by exactly 24 base64url characters. It addresses one bounded in-memory tracker and is not a provider receipt handle.

```bash
embassy delivery-status --token dlv_<token>
embassy wait-delivery --token dlv_<token>
```

`delivery-status` reads the tracker once. `wait-delivery` polls until the tracker is terminal or the delivery deadline passes. It exits `0` only for `delivered`, `6` for any other terminal state (`unconfirmed`, `expired`, `failed`, `ambiguous`, or `cancelled`), `3` for an unknown token, and `4` for a local wait timeout — which is not a terminal state and does not authorize a resend. Tokens are memory-only: after a restart, a prior token reports `found: false`.
