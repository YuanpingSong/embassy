# Delivery semantics

Embassy tracks every accepted message from CLI acceptance through terminal
settlement. This document collects the delivery model in one place: queue
behavior, evidence states, failure handling, retry policy, and the delivery
tokens that let a sender follow a message to settlement. The material is the
authoritative reference for what "delivered" does and does not mean inside
Embassy.

---

- **Timing is directional.** After routing and pre-write checks, a Claude-bound body is written immediately to Claude's native mailbox regardless of its observed busy or idle state. Claude being busy is never a reason to hold that write in Embassy's queue. A Codex-bound ordinary body instead waits for the task to become available. An exact leading `STEER:` body from Claude to Codex may be admitted to the active turn at its next tool-call boundary. Embassy never interrupts or injects text mid-generation; a cleanly unavailable boundary falls back to the normal queue. At most three steering messages remain queued per route, with the oldest settled as `cancelled/STEER_QUEUE_SUPERSEDED` when a fourth is accepted.

- **Acceptance is not completion.** Initial CLI acceptance returns a conversation token and a delivery token. For Claude-bound delivery, `transport_written` means the native mailbox write completed and is the terminal `delivered` boundary; Embassy does not wait for evidence that Claude later read or consumed the body. Toward Codex, `delivered` means the App Server accepted the turn. Neither boundary means a model read, understood, or completed the work.

- **Shell peers acknowledge stdout.** A `peer-*` delivery requires a live `embassy await` waiter. With none, dispatch defers cleanly as `PEER_NOT_AWAITING`. Embassy arms the exact prepared frame, hands it to the waiter, and settles `delivered` only after the CLI has flushed that complete frame to stdout and returned the private receipt. A lost receipt is `unconfirmed`; uncertainty after arming is `ambiguous`. One waiter is allowed per registration and 16 globally; waiter, receipt, and duplicate-ack tombstone state is memory-only.

- **Recipients get provenance and a reply path.** Immediately before the provider write, Embassy puts every routed body inside one broker-owned `<cross-session-message>` textual frame. Its first element is an `<embassy-reply-hint>` with the full conversation token, the recipient's exact alias, and the corresponding `embassy reply` command. A recipient may continue with that exact token, but caller identity, conversation membership, and current route policy are rechecked at reply time.

- **Evidence has three shapes.** `delivered` means the direction's terminal provider boundary was observed. A confirmed Claude mailbox write reaches that boundary immediately. `unconfirmed` means Embassy cannot prove the required terminal boundary despite partial dispatch evidence; it is not a later downgrade from a confirmed Claude mailbox write. `ambiguous` means the write outcome itself is unknown. All three are terminal, and neither `unconfirmed` nor `ambiguous` is a retry authorization — inspect the recipient instead, because a resend can duplicate the message.

- **Native failures.** A Claude-originated route or delivery failure settles as native `expired`; its native acknowledgement always retains the normalized safe code in the reason field. The default `merged` notice mode keeps the early stall frame but suppresses the duplicate terminal `<gateway-delivery-diagnostic>` user frame. `verbose` restores that readable diagnostic frame; `quiet` suppresses all gateway-authored user-frame notices, including stalls, while native status remains truthful. No notice contains a path, native identifier, exception, or message body. `denied` is reserved for a real user or policy refusal and is not authored by Embassy v1. `held` and transport-written are progress, never success.
- **Native held is attempt-then-ack.** For Claude→Codex ingress, Embassy first attempts the exact immediate dispatch. A terminal result observed before the one-second prompt boundary produces only its terminal acknowledgement. Native `held` is sent only when the body actually remains queued (including a busy route or clean provider deferral) or dispatch is still nonterminal at that boundary; the terminal acknowledgement follows later. Claude's rendered “approved and released” notice means only that the paired-consent gateway accepted and released the body to the recipient queue. It does not mean a model read it, and it does not imply human approval.

- **Retries are conservative.** Undispatched Codex-bound messages remain queued while the task is busy or temporarily unavailable. Each attempt opens a fresh App Server transport; registration and connector observation never certify reachability. A clean pre-write deferral may return reserved work to the queue. Once the body write is armed, uncertainty is terminal and never replayed. A Claude-bound body may remain queued only for a pre-write route failure or temporary unavailability, never merely because Claude is observed busy. A confirmed delivery failure settles; an ambiguous write is never retried automatically.

- **Bounded by design.** Bodies, queues, rate windows, deduplication tables, deadlines, and transient conversations all have fixed limits.

- **Progress watches are independent evidence.** An opt-in watch may outlive an opener that expired before delivery, so a worker can remain unaware of the original assignment even while thread activity keeps the watch healthy. Owners should check the opener's `delivery-status` separately before assuming the assignment text arrived.

- **Restarts keep clean work only.** Queued and reserved bodies persist under bounded retention and may resume once against the same logical route and consent edge. Armed or accepted work at crash settles ambiguous or unconfirmed and is never replayed. Each retained message keeps its opaque delivery token and status in the private v5 state, so the sender can continue checking that exact attempt after restart. No pending waiter, shell receipt, reply, or conversation capability survives.

Accepted messages are tracked toward terminal delivery while the broker and provider connections remain healthy. `embassy status` distinguishes acceptance, progress, delivery, expiry, failure, ambiguity, and abandonment.

## Provenance framing and recipient replies

The store, queue, classification, deduplication, rate limiting, and 16 KiB
acceptance limit all operate on the raw body. At the last provider
boundary, Embassy deterministically composes exactly one authoritative textual
frame:

- Toward Codex, the outer `cross-session-message` carries the exact verified
  source alias in `from-name` and the full token in `conversation`.
- Toward Claude, the outer frame uses only Claude Code's canonical bounded
  `from-name`. A source alias longer than 64 characters gets a deterministic
  64-character display label; the first reply hint retains the exact alias in
  `from-alias`. Claude's outer frame does not carry `conversation` because that
  attribute is not part of its canonical parser.
- In both directions, the first `embassy-reply-hint` carries `conversation`,
  `reply-as`, and the exact stdin-based reply command. `reply-as` is the
  recipient's alias, never the sender's. The hint states that caller,
  conversation, and route policy are rechecked.

The full `conv_` conversation token is a transient participant-scoped locator,
not enough authority by itself. The recipient can use the delivered full token, while the
broker still validates inherited caller identity, current conversation
membership, and current route policy. Never reconstruct a token from
the suffix exposed by metadata-only views.

This is Claude-compatible textual framing, not general XML, a cryptographic
signature, or proof that the body is safe. Embassy composes the genuine outer
frame and hint from validated broker metadata. In the untrusted raw body only,
it case-insensitively neutralizes boundary-shaped opening or closing occurrences
of `cross-session-message` and `embassy-reply-hint` by inserting `\` immediately
after their leading `<`. The rest of the body remains byte-for-byte text.
Native Claude wrappers received inside a body are therefore untrusted nested
text beneath Embassy's single authoritative outer frame.

The full conversation token travels only in the accepted control result and
transient provider payload; the composed envelope itself is payload-only.
Aliases retain their existing sanitized public-metadata behavior. The full
token is never persisted, journaled, logged, snapshotted, or placed in a
receipt. A framing, metadata, or size failure happens
before the provider write and settles as a clean failure; it is never
classified as an ambiguous write or replayed.

## Delivery tokens

Every accepted `send` and `reply` returns a delivery token: `dlv_` followed by exactly 24 base64url characters. It addresses one bounded private v5 message/status row and is not a provider receipt handle. The token is persisted only in the mode-0600 broker state; it never enters a public snapshot, normal log, or provider receipt.

```bash
embassy delivery-status --token dlv_<token>
embassy wait-delivery --token dlv_<token>
```

`delivery-status` reads the retained status once. `wait-delivery` polls until the message is terminal or the delivery deadline passes. It exits `0` only for `delivered`, `6` for any other terminal state (`unconfirmed`, `expired`, `failed`, `ambiguous`, or `cancelled`), `3` for an unknown token, and `4` for a local wait timeout — which is not a terminal state and does not authorize a resend. A retained pre-restart token continues to resolve after restart; `found: false` means that exact token is not present in the bounded state, for example after terminal retention eviction.
