All six blocks are drafted. Here they are ready to paste:

---

## README-SECTION

> Paste into README.md after the existing "## Dashboard" section.

### Live dashboard

`embassy dashboard --live` starts a separate foreground companion process that
streams the same metadata shown by the static dashboard into a browser tab. It
binds `127.0.0.1` on an ephemeral port; the companion is not part of
`embassy serve`, which remains socket-only with no TCP or HTTP listener.

Access bootstraps through a one-use 256-bit URL-fragment token exchanged for a
path-scoped `HttpOnly` `SameSite=Strict` session cookie. Host, Origin, and
sentinel headers are checked on every request. There are no CORS headers, no
mutation or provider routes, no storage, no telemetry, and no external assets.
The browser has zero authority to register, select, send, reply, approve, or
interrupt — it receives a read-only sanitized metadata snapshot only, streamed
via authenticated `fetch`. A snapshot observation may settle already-due
lifecycle deliveries before projecting state.

An optional `--lang en|zh-CN` flag selects the display language.

**Caveat.** Any process running as your OS user — including root and browser
extensions with local filesystem access — can read what the browser can read.

The static `gateway-dashboard.html` file remains the inert offline floor:
mode 0600, no script, no network.

---

## SITE-TRUTH-ITEM

> Replaces or follows the existing "no TCP or HTTP listener" claim in the protocol-truth list.

- **`embassy serve` opens no TCP or HTTP listener; the opt-in live companion
  does.** `embassy dashboard --live` is a separate foreground process that binds
  `127.0.0.1` on an ephemeral port for a read-only authenticated metadata
  stream. It has no mutation, provider, or CORS surface. The static dashboard
  file remains an inert offline floor with no script or network dependency.

---

## SECURITY-ADDITION

> Append to SECURITY.md before "## Validation boundary".

### Live companion boundary

`embassy dashboard --live` binds a read-only HTTP listener on `127.0.0.1` with
an ephemeral port. It is a separate foreground process from `embassy serve`.
Access requires a one-use 256-bit URL-fragment token exchanged for a
path-scoped `HttpOnly` `SameSite=Strict` session cookie; Host, Origin, and
sentinel headers are checked on every request. There are no CORS headers, no
mutation or provider routes, no storage, no telemetry, and no external assets.
The browser receives a read-only sanitized metadata snapshot and has no
authority to register, select, send, reply, approve, or interrupt. Any process
running as your OS user — including root and browser extensions with local
filesystem access — can read what the browser can read.

Reports involving the live companion are in scope if they demonstrate a path by
which a remote origin, a cross-site request, or a process running as a
different OS user can read the authenticated stream or bypass the token-to-cookie
exchange. Same-UID local reads are within the documented containment model and
are not treated as vulnerabilities unless they bypass an explicit control such
as accessing a session without presenting the cookie.

---

## CHANGELOG-LINES

> Append under `### Added` in the next release entry.

- **Live dashboard companion** — `embassy dashboard --live [--lang en|zh-CN]` starts a separate foreground process that streams sanitized metadata to a browser tab on `127.0.0.1`; `embassy serve` remains TCP-free and HTTP-free.
- **One-use token authentication** — live companion access bootstraps via a 256-bit URL-fragment token exchanged for a path-scoped `HttpOnly` `SameSite=Strict` session cookie with Host, Origin, and sentinel validation.
- **Read-only browser surface** — the live companion exposes no CORS headers, no mutation or provider routes, no storage, no telemetry, and no external assets; the browser has zero authority to register, select, send, reply, approve, or interrupt.
- **Bilingual live display** — `--lang en|zh-CN` selects English or Simplified Chinese for the live dashboard.

---

## RELEASE-NOTES-PARA

> Paste into the release notes body.

New in this release: `embassy dashboard --live` adds an opt-in live dashboard companion, a separate foreground process that streams the same sanitized metadata as the static dashboard into a browser tab. It binds `127.0.0.1` on an ephemeral port; `embassy serve` itself remains socket-only with no TCP or HTTP listener. Access bootstraps through a one-use 256-bit token exchanged for a scoped session cookie, with Host, Origin, and sentinel checks on every request. The browser receives read-only metadata only — no mutation, provider, CORS, storage, telemetry, or external-asset surface. Any process running as your OS user, including root and browser extensions with local access, can read what the browser can read. An optional `--lang en|zh-CN` flag selects the display language. The static `gateway-dashboard.html` file remains the offline floor.

---

## SKILL-NOTE

> Append to the agent skill's behavioral guidance or dashboard section.

Agents do not use the live dashboard; it is an operator-facing browser surface with no registration, selection, send, reply, or approval authority. Agent-facing paths remain `embassy status` for a sanitized snapshot and the static `gateway-dashboard.html` for offline metadata. A status snapshot observation may settle already-due lifecycle deliveries before projecting state.

---

All six blocks written. Key scoping decisions: every existing "no TCP/HTTP listener" claim now applies to `embassy serve` specifically; the live companion is described as a separate process with its own bounded surface; the same-UID caveat is carried forward explicitly (including the root/extension note); and the observe_snapshot settlement behavior appears in both the README section and the skill note. The file write to `docs/product-copy/live-dashboard-prose.md` was blocked by permissions — accept the retry if you'd like the blocks persisted there as well.
