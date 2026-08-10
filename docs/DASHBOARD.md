# Dashboards

Embassy ships two dashboard surfaces: a metadata-only static file pair and a
live streaming companion that may also show bounded retained message bodies.
This document covers both: the static snapshot model and the live companion's
tabs, request controls, bounded actions, and security caveat.

---

## Static dashboard

Open `gateway-dashboard.html` inside the configured state directory. It gives a metadata-only view of connector health, available and selected Claude peers, the registered Codex route, recent delivery states, queue depth, latency, and safe alerts.

Interpret queue and delivery by direction. Codex-bound ordinary work can wait
for the task to become idle. Claude-bound work does not wait for Claude idle:
after routing and pre-write checks it enters Claude's native mailbox
immediately, and `transport_written` settles that direction as `delivered`.
The mailbox boundary does not mean Claude read or consumed the body.

Every publish writes the language pair — `gateway-dashboard.html` and `gateway-dashboard.zh-CN.html` — side by side in the state directory, and each page carries an in-page link to the other. That link is the only way to switch the static language; `--lang` is a flag of the live companion, not of `refresh-dashboard`.

A static page is a point-in-time snapshot and never refreshes itself. Run `embassy refresh-dashboard` and reload to see newer state, or run `embassy dashboard --live` for a streaming view.

The static dashboard is deliberately a file rather than a web application. Anything already running as your OS user can read it, so place `EMBASSY_STATE_DIR` outside agent workspaces if that distinction matters to you.

## Live dashboard

With `embassy serve` already running in another terminal, start the companion in a third:

```bash
embassy dashboard --live
```

`embassy dashboard --live` starts a separate foreground companion process that
uses a five-tab browser view (overview, deliveries, routes, activity,
diagnostics) to stream broker state, including bounded retained bodies in
delivery detail. It reaches the broker over the same private control socket
every other command uses, so it reports the gateway as unavailable when
nothing is serving. The companion is not part of `embassy serve`, which
remains socket-only with no TCP or HTTP listener.

The companion binds exact `127.0.0.1` on stable port `41961` by default and is
available directly at `http://127.0.0.1:41961/`. To choose another stable port
for one invocation, pass `--port <n>` with an integer from 1024 through 65535:

```bash
embassy dashboard --live --port 41962
```

The command auto-opens a browser and its ready result prints the same
bookmarkable dashboard URL. Up to four concurrent live views—across windows,
tabs, or browsers—can use that URL while the foreground process runs; a fifth
stream is refused until one closes. If the port is already occupied, startup fails with
`LIVE_DASHBOARD_PORT_IN_USE`, tells the operator to choose another with
`--port`, and does not select an ephemeral or alternate port.

There is no fragment capability, cookie, login, per-browser session, or
bootstrap file. The intended posture is one operator and software already
trusted under that operator's macOS UID. The HTTP listener deliberately does
not authenticate a process or OS user, so this remains a trusted
single-user-machine assumption rather than a same-UID enforcement mechanism.
Any local software that can reach or spoof loopback can read the live view,
including retained bodies, and submit its bounded actions.

The exact Host header is checked on every request. Navigation GETs may omit
Origin, but every POST requires the exact Origin plus
`X-Embassy-Request: 1`. `OPTIONS` is not accepted and no CORS headers are sent.
These checks constrain browser cross-origin requests; they do not authenticate
local software. There are no generic control or provider routes, telemetry, or
external assets. The only mutation route accepts exact pair, unpair,
refresh-discovery, and stale-Codex-registration-removal actions, requires an
explicit in-page confirmation, rejects bodies over 1 KiB, and is limited to
six actions per minute. Removal names only a public `codex-*` alias; the broker
accepts it only when the registration is stale and its endpoint generation is
dead. No task ID or endpoint generation enters the browser contract. The
browser client keeps only a display-preference key
(active tab and language) in `localStorage`.
The browser cannot create or live-unregister tasks, send, reply, approve,
interrupt, change settings, or invoke arbitrary broker/provider methods. It receives a sanitized
snapshot via same-origin `fetch`; after each bounded action it reads
a fresh snapshot. A snapshot observation may settle already-due
lifecycle deliveries before projecting state.

An automatically exact-version-and-generation-gated App Server endpoint
refresh appears in Activity as an automatic event, distinct from operator
actions. Diagnostics reports a safe version, schema, or generation failure
code when a replacement is incompatible, while a missing or duplicate exact
task remains stale. Compatibility remains passive status: the dashboard has no
compatibility action or override. The dashboard never exposes the
retained task ID or either endpoint generation, and endpoint recovery never
replays a message body.

An optional `--lang en|zh-CN` flag selects the display language. It belongs to
the live companion only; the static pair is always written in both languages
and switched by the in-page link.

**Caveat.** The loopback listener does not identify the caller's process or
UID. Run it only on a trusted single-user machine: local processes, other local
users, root, and browser extensions able to reach or spoof loopback may read
and act on everything the live dashboard exposes.

The static `gateway-dashboard.html` and `gateway-dashboard.zh-CN.html` files
remain the inert offline floor: mode 0600, no script, no network.
