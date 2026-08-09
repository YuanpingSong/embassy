# Threat Model — Live Dashboard Mutation Surface (Phase B.1)

Owner: PM. Status: implemented with deterministic boundary tests; final visual
browser QA remains a release check. Scope: exactly four bounded operator
actions — **pair**, **unpair**, **refresh discovery**, and **remove a stale
Codex registration** — available to the live companion's authenticated
session (PRD §3.3 plus the v1.1 recovery change order). Registration creation, send,
reply, approve, interrupt, and settings mutation remain out of scope for
this surface (registration handshake and the settings store are separate
broker work with their own reviews).

## 1. What changes

The live companion retains navigation GETs (shell/assets) and three existing
authenticated POSTs (`session`, `snapshot`, `stream`). Phase B.1 adds one
authenticated POST route:

```
POST <instancePath>/action
Content-Type: application/json
{"action": "pair", "claudeAlias": "<claude-alias>", "codexAlias": "<codex-alias>"}
{"action": "unpair", "claudeAlias": "<claude-alias>", "codexAlias": "<codex-alias>"}
{"action": "refresh_dashboard"}
{"action": "remove_stale_codex_registration", "alias": "<codex-alias>"}
```

The handler forwards the verb to the broker over the same private control
socket the observer already uses, and returns the broker's `{ok, code}`
verbatim (safe codes only, no internals). State truth stays in the broker;
the dashboard learns the outcome the same way it learns everything — from
the next snapshot. Stale-registration recovery carries no task ID or endpoint
generation. The broker accepts it only for a stale registration whose owning
endpoint generation is dead, settles bounded work at the boundary, removes its
incident pair edges, and journals the operator action. A live generation makes
the request fail closed.

## 2. Authentication and request policy (unchanged core + action tier)

Every `/action` request must pass ALL of:

1. Exact `Host: 127.0.0.1:<port>` (existing pipeline).
2. Valid session cookie — HttpOnly, `SameSite=Strict`, path-scoped, minted
   once from the one-use 256-bit URL-fragment capability.
3. Exact `Origin: http://127.0.0.1:<port>` (non-navigation POST rule).
4. `X-Embassy-Request: 1` sentinel header.
5. Method POST; `Content-Type: application/json`; body ≤ 1 KiB.
6. Action allowlist: exactly `pair | unpair | refresh_dashboard |
   remove_stale_codex_registration`. Unknown action → 400 before any broker
   contact. Recovery accepts exactly `{action, alias}` with a canonical
   `codex-*` alias; native IDs and extra fields are rejected.
7. Rate limit: a token bucket per session of 6 actions per 60 s, refilling
   linearly; excess → 429 with `Retry-After`. The bucket is in-memory in
   the companion (single session by design).

`session`, `snapshot`, `stream`, and all navigation routes are untouched.

## 3. Assets and trust boundaries

- **Asset**: the operator's consent topology (which Claude session Codex
  can reach). Wrong selection = misdirected agent messages (same-user
  sessions only; bodies still never cross the dashboard).
- **Boundary 1 — network**: loopback bind, ephemeral port. Remote origins
  cannot reach the listener at all.
- **Boundary 2 — browser**: the cookie. Only the tab that claimed the
  one-use capability holds it. `SameSite=Strict` + exact-Origin + custom
  sentinel means a hostile page (any origin, including other loopback
  ports) cannot ride the session: cross-site POSTs omit the cookie, can't
  set the sentinel without a CORS preflight (which the server never
  answers permissively — there are no CORS headers at all), and carry the
  wrong Origin.
- **Boundary 3 — machine/user**: any same-UID process already owns the
  private control socket directly; the dashboard adds no authority a local
  actor lacks. This surface changes the *browser's* authority only, and
  only for the one authenticated tab.

## 4. Abuse cases considered

| # | Attack | Disposition |
|---|---|---|
| A1 | CSRF from a hostile web page | Defeated three ways independently: SameSite=Strict cookie, exact-Origin check, sentinel header (unsettable cross-origin without a preflight that never succeeds). |
| A2 | XSS inside the dashboard escalating to mutations | CSP `script-src 'self'` with zero inline script; the app renders exclusively through React text nodes; no `dangerouslySetInnerHTML` anywhere (test-enforced). Residual risk accepted: an attacker who can modify served assets already owns the user account (Boundary 3). |
| A3 | Token/capability theft from the URL fragment | Fragment is stripped by `history.replaceState` before the session exchange; one-use server-side; never logged. Unchanged from the read contract; mutations raise the stakes but not the exposure. |
| A4 | Replay of a captured action request | Requires the HttpOnly cookie, which never leaves the browser. Loopback traffic is not capturable cross-user without root (out of scope: root owns everything). Pair, unpair, and refresh are repeat-safe. Replaying a completed stale-registration removal returns `not_found`; it cannot widen the target beyond the exact alias and is bounded by the rate limit. |
| A5 | Confused deputy via crafted alias | The companion validates shape only (string, length ≤ 128, gateway alias grammar) and forwards; the broker's own verb validation is authoritative — the same validation the CLI path uses. The dashboard can not name a verb outside the allowlist. |
| A6 | Flooding actions to churn selection state | Rate limit (6/min) + single-session design + journal visibility. Selection churn is also self-evident in the UI. |
| A7 | Downgrade/differential: tricking the read-only footer | The footer copy MUST name the exact authority the session now carries (pair, unpair, refresh discovery, and request stale-registration removal — nothing else). Claiming read-only while carrying mutations would violate the honesty canon; treated as a release blocker. |
| A8 | Unavailable broker mid-action | The control call fails closed; the UI surfaces the safe code and re-reads the snapshot. No retry loops; the operator decides. |
| A9 | Crafted recovery request targets a live task | The browser can name only a canonical public alias. The broker independently requires stale route state plus a dead owning endpoint generation; a live generation or any ambiguity fails closed. |

## 5. What this surface deliberately does NOT do

- No registration creation or ordinary live unregistration (identity must be
  inherited inside the Codex task). The recovery verb can only retire a
  broker-proven stale orphan on a dead endpoint generation.
- No message send/reply/approve/interrupt — the native approval surfaces
  keep sole authority over content flow.
- No settings mutation (deadline, queue depth, inbound mode, steering
  switch) — requires the broker settings store; separate review.
- No new listener, no new socket, no CORS, no cookie scope change, no
  capability lifetime change.

## 6. UX consent contract (PRD §3.3 requirements binding here)

Every action renders a one-line consequence before an explicit confirm
step (including the stale-and-dead-generation condition for recovery),
uses the current paired-route broker truth for its language, reports failure with the
broker's safe code, and never renders as available when the stream is
disconnected (stale-state mutations are refused client-side and the
consequence line names the staleness).

## 7. Journal contract

The broker journals accepted operator actions with its operator-action marker.
Stale-registration recovery is recorded only after the stale/dead-generation
guard succeeds. The dashboard MUST NOT synthesize ledger rows — the Activity
tab shows only the broker's bounded public journal.

## 8. Test obligations

1. `/action` refuses: missing cookie, wrong Origin, missing sentinel,
   wrong Host, GET/PUT/DELETE, oversized body, unknown action, non-JSON
   body — each with the correct status and no broker contact (assert via
   a recording control stub).
2. Rate limit: 7th action within the window → 429 + `Retry-After`; bucket
   refills.
3. Happy paths: each verb forwards exactly once with exactly the validated
   params; broker `{ok:false, code}` passes through verbatim.
4. Recovery boundary: the browser forwards only the public alias; the broker
   refuses ready, merely offline, or live-generation routes and removes only a
   stale registration whose owning generation is dead.
5. Static analysis: no `dangerouslySetInnerHTML`, no new CORS headers, no
   change to session/snapshot/stream handlers (snapshot tests on the
   route table).
6. UI: consequence-confirm flow reachable by keyboard; actions disabled
   while disconnected; footer authority copy updated in both locales.
