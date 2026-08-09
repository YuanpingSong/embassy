# Dashboards

Embassy ships two dashboard surfaces — a static file pair and a live streaming
companion — that present gateway metadata without exposing message content.
This document covers both: the static snapshot model and the live companion's
tabs, access controls, bounded actions, and security caveat.

---

## Static dashboard

Open `gateway-dashboard.html` inside the configured state directory. It gives a metadata-only view of connector health, available and selected Claude peers, the registered Codex route, recent delivery states, queue depth, latency, and safe alerts.

Every publish writes the language pair — `gateway-dashboard.html` and `gateway-dashboard.zh-CN.html` — side by side in the state directory, and each page carries an in-page link to the other. That link is the only way to switch the static language; `--lang` is a flag of the live companion, not of `refresh-dashboard`.

A static page is a point-in-time snapshot and never refreshes itself. Run `embassy refresh-dashboard` and reload to see newer state, or run `embassy dashboard --live` for a streaming view.

The static dashboard is deliberately a file rather than a web application. Anything already running as your OS user can read it, so place `EMBASSY_STATE_DIR` outside agent workspaces if that distinction matters to you.

## Live dashboard

With `embassy serve` already running in another terminal, start the companion in a third:

```bash
embassy dashboard --live
```

`embassy dashboard --live` starts a separate foreground companion process that
presents gateway metadata in a five-tab browser view (overview, deliveries,
routes, activity, diagnostics), streaming the same data the static dashboard
snapshots. It
reaches the broker over the same private control socket every other command
uses, so it reports the gateway as unavailable when nothing is serving. It
binds `127.0.0.1` on an ephemeral port; the companion is not part of
`embassy serve`, which remains socket-only with no TCP or HTTP listener.

Access bootstraps through a one-use 256-bit URL-fragment token exchanged for a
path-scoped `HttpOnly` `SameSite=Strict` session cookie. The exact Host header is checked on every request; navigation GETs permit a
missing Origin and carry no sentinel, while non-navigation POSTs require the
exact Origin plus the X-Embassy-Request sentinel. There are no CORS headers, no
generic control or provider routes, no server-side storage, no telemetry, and
no external assets. The only mutation route accepts exact select-Claude,
unselect-Claude, and refresh-discovery actions, requires an explicit in-page
confirmation, rejects bodies over 1 KiB, and is limited to six actions per
minute. The browser client keeps only a display-preference key
(active tab and language) in `localStorage`.
The browser cannot register tasks, send, reply, approve, interrupt, change
settings, or invoke arbitrary broker/provider methods. It receives a sanitized
metadata snapshot via authenticated `fetch`; after each bounded action it reads
a fresh snapshot. A snapshot observation may settle already-due
lifecycle deliveries before projecting state.

An optional `--lang en|zh-CN` flag selects the display language. It belongs to
the live companion only; the static pair is always written in both languages
and switched by the in-page link.

**Caveat.** Any process running as your OS user — including root and browser
extensions with local filesystem access — can read what the browser can read.

The static `gateway-dashboard.html` and `gateway-dashboard.zh-CN.html` files
remain the inert offline floor: mode 0600, no script, no network.
