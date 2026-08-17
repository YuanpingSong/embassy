# Threat Model — Live Dashboard Mutation Surface

Status: implemented with deterministic boundary tests. Scope: exactly four
bounded operator actions — **pair**, **unpair**, **refresh discovery**, and
**remove a named Codex registration** — available to the live companion.
Registration creation, send, reply, approve, interrupt, and settings mutation
remain out of scope for this surface; the registration handshake and the
settings store are separate broker work with their own reviews.

## 1. What changes

The live companion serves navigation GETs (shell/assets), POST-based snapshot
and stream reads, and one POST action route:

```
POST /action
Content-Type: application/json
{"action": "pair", "aliases": ["<alias-a>", "<alias-b>"]}
{"action": "unpair", "aliases": ["<alias-a>", "<alias-b>"]}
{"action": "refresh_dashboard"}
{"action": "remove_codex_registration", "alias": "<codex-alias>"}
```

The handler forwards the verb to the broker over the same private control
socket the observer already uses, and returns the broker's `{ok, code}`
verbatim (safe codes only, no internals). State truth stays in the broker;
the dashboard learns the outcome the same way it learns everything — from
the next snapshot. Registration removal carries no task ID. In one fencing
commit, the broker settles active work by its durable write phase, removes the
route and its incident consent edges, and records the bounded operator
activity. Queued or reserved work becomes cancelled, armed work becomes
ambiguous, and accepted work becomes unconfirmed; neither uncertain class is
replayed.

## 2. Access and request policy

The companion binds exact `127.0.0.1` on stable port `41961` by default, or the
integer supplied through the per-invocation `--port <n>` option in the closed
range 1024 through 65535. Its direct root URL has no authentication ceremony
and is usable from multiple windows and browsers. There is no fragment
capability, cookie, browser session, random instance path, or bootstrap file. A
port collision fails closed and directs the operator to `--port`; it never
chooses another port automatically.

Every `/action` request must pass ALL of:

1. Exact `Host: 127.0.0.1:<port>` (existing pipeline).
2. Exact `Origin: http://127.0.0.1:<port>` (every-POST rule).
3. `X-Embassy-Request: 1` sentinel header.
4. Method POST; `Content-Type: application/json`; body ≤ 1 KiB.
5. Action allowlist: exactly `pair | unpair | refresh_dashboard |
   remove_codex_registration`. Unknown action → 400 before any broker
   contact. Removal accepts exactly `{action, alias}` with a canonical
   `codex-*` alias; native IDs and extra fields are rejected.
6. Rate limit: one companion-wide token bucket of 6 actions per 60 s, refilling
   linearly; excess → 429 with `Retry-After`. The bucket is in-memory in
   the companion.

The exact Host check applies to every request. `snapshot` and `stream` are
POSTs and therefore require the same exact Origin and sentinel. Navigation
GETs may omit Origin. `OPTIONS` is rejected and the server sends no CORS
headers.

## 3. Assets and trust boundaries

- **Asset**: the operator's consent topology (which Claude session Codex can
  reach) plus bounded retained message bodies. Wrong selection means
  misdirected agent messages.
- **Boundary 1 — network**: exact IPv4 loopback bind on a stable configured
  port. A remote network peer cannot connect to that interface.
- **Boundary 2 — browser origin**: exact Host on every request plus exact
  Origin and the custom sentinel on every POST prevent a hostile web origin
  from reading or mutating through ambient browser authority. Such a page
  cannot set the sentinel without a CORS preflight, and the server rejects
  `OPTIONS` and sends no CORS headers.
- **Boundary 3 — machine/user**: the intended posture is one operator and
  software already trusted under that operator's macOS UID. The HTTP listener
  does not authenticate a process or UID; any local software that can reach or
  spoof loopback can read the view and invoke its bounded operations. The
  product therefore assumes a trusted single-user machine; request-shape
  guards are not a sandbox against local code or an OS-level same-UID check.

## 4. Abuse cases considered

| # | Attack | Disposition |
|---|---|---|
| A1 | CSRF from a hostile web page | Exact-Origin plus the sentinel header block the POST; the sentinel is unsettable cross-origin without a preflight, and `OPTIONS` is rejected with no CORS headers. |
| A2 | XSS inside the dashboard escalating to mutations | CSP `script-src 'self'` with zero inline script; the app renders exclusively through React text nodes; no `dangerouslySetInnerHTML` anywhere (test-enforced). Residual risk accepted: an attacker who can modify served assets already owns the user account (Boundary 3). |
| A3 | Local process or local user opens the stable URL | Accepted only under the explicit trusted single-user-machine assumption. The companion does not authenticate a process or UID; run it only where all local software is trusted. |
| A4 | Replay of an action request | Local software can construct requests by design. Pair, unpair, and refresh are repeat-safe; replaying a completed registration removal returns `not_found`. Broker revalidation, the exact action allowlist, alias bounds, and the companion-wide rate limit contain each request. |
| A5 | Confused deputy via crafted alias | The companion validates shape before forwarding: an exact key set for the verb, string type, length ≤ 128, gateway alias grammar, the required `codex-` prefix for removal, and — for pair/unpair — an identical host suffix on both aliases. The broker's own verb validation is then authoritative, the same validation the CLI path uses. The dashboard can not name a verb outside the allowlist. |
| A6 | Flooding actions to churn selection state | Companion-wide rate limit (6/min) plus journal visibility. Selection churn is also self-evident in the UI. |
| A7 | Downgrade/differential: tricking the read-only footer | The footer copy MUST name the exact authority the live surface carries (pair, unpair, refresh discovery, and request named-registration removal — nothing else). Claiming read-only while carrying mutations would violate the honesty canon; treated as a release blocker. |
| A8 | Unavailable broker mid-action | The control call fails closed; the UI surfaces the safe code and re-reads the snapshot. No retry loops; the operator decides. |
| A9 | Accidental removal targets active work | The browser can name only a canonical public Codex alias and requires a consequence confirmation. The broker's one fencing commit settles each message from durable phase and removes incident consent; it never waits for, interrupts, or replays a turn. |

## 5. What this surface deliberately does NOT do

- No registration creation (identity must be inherited inside the Codex task).
  Removal is explicit operator authority over one exact public Codex alias.
- No message send/reply/approve/interrupt — the native approval surfaces
  keep sole authority over content flow.
- No settings mutation (deadline, queue depth, inbound mode, steering
  switch) — requires the broker settings store; separate review.
- No non-loopback listener, no authentication ceremony, no CORS, and no
  fallback port.

## 6. UX consent contract

Every action renders a one-line consequence before an explicit confirm
step. Registration removal names the exact alias, incident-edge deletion, and
phase-specific settlement outcomes. It reports failure with the
broker's safe code, and never renders as available when the stream is
disconnected.

## 7. Activity contract

The broker records accepted operator actions with its operator-action marker.
Registration removal is recorded only as part of the successful fencing
commit. This is bounded native activity, not a transaction journal. The
dashboard MUST NOT synthesize ledger rows — the Activity tab shows only the
broker's bounded public activity.

## 8. Test obligations

1. `/action` refuses: wrong Origin, missing sentinel, wrong Host,
   GET/PUT/DELETE/OPTIONS, oversized body, unknown action, non-JSON
   body — each with the correct status and no broker contact (assert via
   a recording control stub).
2. Rate limit: 7th action within the window → 429 + `Retry-After`; bucket
   refills.
3. Happy paths: each verb forwards exactly once with exactly the validated
   params; broker `{ok:false, code}` passes through verbatim.
4. Removal boundary: the browser forwards only the public Codex alias; the
   broker atomically settles queued/reserved, armed, and accepted work with the
   exact removal outcomes and removes incident consent edges.
5. Static analysis: no `dangerouslySetInnerHTML` and no CORS headers; route
   tests cover root/assets plus the snapshot, stream, and action POSTs.
6. UI: consequence-confirm flow reachable by keyboard; actions disabled
   while disconnected; footer authority copy updated in both locales.
