# Change Order — User-Editable Settings (Dashboard Design)

PM-approved. Status: designed, not yet implemented — the shipped dashboard
renders these settings read-only with their env var names, and every edit
path gates on the mutation threat-model review. Scope: ONLY the settings an
operator actually adjusts to run Embassy smoothly. Everything else remains launch-time environment
configuration, shown read-only in Diagnostics.

## Design principle

**Settings live where their evidence lives.** No monolithic settings tab.
Each editable setting appears next to the data that motivates changing it,
plus one compact "Editable settings" list in Diagnostics for findability.
Every edit: consequence line → confirm → Activity-ledger entry with an
operator-action marker. (Engineering note: these are env vars today;
dashboard editing is a new, threat-model-gated mutation class. Settings
that cannot apply live are staged and badged "applies on next serve.")

## The editable four

1. **Message deadline** (`EMBASSY_MESSAGE_DEADLINE_MS`, default 5 min) —
   edited in **Diagnostics**, right beside the deadline-vs-turn-length
   pressure display. When the display recommends a value ("your deadline
   expired N messages this week"), offer **Apply suggestion** as one click.
   This is the setting our own usage proved users must tune: five minutes
   against hour-long agent turns caused every silent expiry we lived
   through. Applies to newly accepted messages immediately.

2. **Inbound mode per route** (paired ⇄ open) — edited in **Routes &
   Sessions**, on the pair itself. Consent-tier confirmation both ways;
   switching to open shows the warning-tier consequence ("any live Claude
   session under this OS user may message this task") and lights the
   persistent open-mode badge from the paired-routes change order.

3. **Steering switch** (global on/off) — edited in **Diagnostics** system
   area, surfaced read-only wherever steer events appear. Consequence line
   on disable: "queued delivery only; STEER: prefixes are treated as
   ordinary messages." Applies live.

4. **Queue depth per route** — *contextually only*: when a QUEUE_FULL or
   queue-stalled alert fires in Needs attention, the alert itself offers
   "Raise limit to N" alongside the usual next-command copy. No standing
   editor; the moment of need is the interface.

Plus one **UI preference** (not a broker setting): the language toggle
(en / 简体中文), persisted client-side, mirroring the static dashboards'
in-page switch.

## Explicitly NOT editable in the dashboard

State directory, launcher paths, version pins, the 16 KiB body cap, socket
locations, rate-limit windows, host allowlists — structural identity and
protective bounds, read-only in Diagnostics with their env var names shown
for operators who need to change them at launch. (Message-body retention,
when it ships per PRD §6b, joins the editable set with its own consent
treatment — designed then, not now.)

## Acceptance

An operator whose messages keep expiring should get from the symptom to a
fixed deadline in two clicks without reading documentation. No setting
edit ever happens without a stated consequence, and none is reachable from
outside the foreground loopback companion. Every request keeps its exact Host
check, and every POST keeps the exact Origin plus `X-Embassy-Request` boundary;
under the trusted single-user-machine posture these checks constrain browser
origins but do not authenticate local software.
