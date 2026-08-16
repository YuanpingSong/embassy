import type { DashboardCopy } from "./dashboard-copy.js";

export const dashboardCopyEn = {
  "meta.title": "Embassy — local exchange register",
  skip: "Skip to Embassy status",
  "language.label": "Language",
  "language.en": "English",
  "language.zhCn": "简体中文",
  "brand.eyebrow": "Local agent exchange",
  "brand.title": "Embassy",
  "brand.subtitle":
    "A point-in-time, metadata-only register of routes between local agent providers.",
  "snapshot.asOf": "Snapshot {time}",
  "snapshot.static":
    "This file does not update itself. If the broker is not running, run embassy serve first. Then run embassy refresh-dashboard and reload — or run embassy dashboard --live for a streaming view.",
  "overall.ready": "Exchange ready",
  "overall.setup": "Setup incomplete",
  "overall.attention": "Needs attention",
  "exchange.eyebrow": "Exchange board",
  "exchange.title": "Provider routes and explicit boundaries",
  "exchange.note":
    "Each consent edge names two verified provider endpoints. Native discovery remains machine-wide; permission does not.",
  "inbound.paired.badge": "Paired inbound",
  "inbound.paired.body":
    "Each registered endpoint accepts messages only across its explicit consent edges.",
  "inbound.open.badge": "Open inbound",
  "inbound.open.body":
    "Any live same-user endpoint allowed by the provider may initiate inbound work; explicit sends still require an edge.",
  "inbound.noPair.body":
    "No consent edge exists; paired-mode endpoints refuse unpaired senders.",
  "exchange.claude.title": "Claude sessions",
  "exchange.claude.note": "Consent-edge endpoints",
  "exchange.codex.title": "Codex tasks",
  "exchange.codex.note": "Consent-edge endpoints",
  "exchange.provider.note": "Consent-edge endpoints",
  "exchange.pouch.title": "Local pouch",
  "exchange.pouch.empty": "Queue clear",
  "exchange.pouch.queued": "{count} queued",
  "exchange.pouch.oldest": "Oldest wait {age}",
  "exchange.count.claude":
    "{ready} selected · {selectable} selectable · {total} discovered",
  "exchange.count.codex": "{ready} ready · {total} registered",
  "app.overview.count.provider": "{ready} ready · {total} registered",
  "status.ready": "Ready",
  "status.busy": "Busy",
  "status.waiting": "Waiting",
  "status.missing": "Not configured",
  "status.attention": "Unavailable",
  "status.selected": "Selected",
  "status.available": "Available",
  "status.notSelectable": "Not selectable",
  "status.enabled": "Enabled",
  "status.disabled": "Disabled",
  "next.label": "Next",
  "next.none": "No action needed.",
  "next.discoverClaude":
    "Start or keep a Claude Code session running, then run embassy refresh-dashboard.",
  "next.selectClaude":
    "Run embassy select-claude --alias <alias> to choose a visible session explicitly.",
  "next.pairRoutes":
    "Create an explicit edge with embassy pair --from <alias> --to <alias>.",
  "next.restoreClaude":
    "Refresh discovery, then explicitly select the current Claude alias if it is not restored.",
  "next.repairClaude":
    "No live, collision-free session is selectable. Resolve the issue shown in Sessions & routes, then refresh discovery.",
  "next.registerCodex":
    "Inside the Codex task, run embassy register-codex --alias codex-<name>@<host>.",
  "next.restoreCodex":
    "Re-run embassy register-codex --alias <alias> inside that exact Codex task.",
  "attention.eyebrow": "Needs attention",
  "attention.title": "Resolve before sending",
  "attention.count": "{count} active",
  "attention.countVisible": "{count} shown",
  "attention.projectionOnly":
    "Additional alert metadata was omitted before dashboard projection. Review the bounded-display note and run embassy status.",
  "attention.scope": "Scope",
  "severity.info": "Info",
  "severity.warning": "Warning",
  "severity.error": "Error",
  "guidance.reobserveClaude.title": "Claude selection needs observation",
  "guidance.reobserveClaude.body":
    "The saved route does not currently have a matching live endpoint proof.",
  "guidance.reobserveClaude.action":
    "Refresh discovery and explicitly select the current Claude alias.",
  "guidance.reobserveCodex.title": "Codex registration needs observation",
  "guidance.reobserveCodex.body":
    "The saved route does not currently have a matching live endpoint proof.",
  "guidance.reobserveCodex.action":
    "Re-run register-codex inside that exact Codex task.",
  "guidance.codexReactivationRequired.title": "Saved Codex route is not live",
  "guidance.codexReactivationRequired.body":
    "The consent edge remains, but the saved Codex route has no current live endpoint proof.",
  "guidance.codexReactivationRequired.action":
    "Inside that exact Codex task, run embassy register-codex --alias {alias}.",
  "guidance.consentEdgeUnavailable.title": "Consent edge endpoint unavailable",
  "guidance.consentEdgeUnavailable.body":
    "The consent edge remains, but this saved endpoint is unavailable in the current bounded snapshot.",
  "guidance.consentEdgeUnavailable.action":
    "Run embassy refresh-dashboard first. If the endpoint is still absent, restore the exact endpoint shown in Scope; do not recreate the consent edge.",
  "guidance.claudeNotObserved.title": "Selected Claude session is not visible",
  "guidance.claudeNotObserved.body":
    "The selected session is absent from current local discovery.",
  "guidance.claudeNotObserved.action":
    "Keep Claude running with crossSessionInbound enabled, refresh, then select its current alias.",
  "guidance.codexStale.title": "Codex route is stale",
  "guidance.codexStale.body":
    "The registered Codex task no longer has a ready App Server connection.",
  "guidance.codexStale.action":
    "Re-run register-codex with the same alias inside that exact Codex task. Do not unregister first.",
  "guidance.codexAppReconnectRequired.title": "Waiting for the Codex app",
  "guidance.codexAppReconnectRequired.body":
    "The managed App Server is reachable, but this saved task is still not observable; the app or task may not have reconnected.",
  "guidance.codexAppReconnectRequired.action":
    "Open the Codex app and this exact task. If the app was already open when the daemon restarted, relaunch it with /usr/bin/open --env CODEX_APP_SERVER_USE_LOCAL_DAEMON=1 -a ChatGPT. Do not resend queued mail.",
  "guidance.connectorOffline.title": "A provider connector is offline",
  "guidance.connectorOffline.body":
    "Embassy cannot currently reach the local provider connector.",
  "guidance.connectorOffline.action":
    "Run embassy status. If a broker restart is necessary, queued mail survives and resumes exactly once; only a write in flight at the crash settles ambiguous.",
  "guidance.routeStale.title": "A route is stale",
  "guidance.routeStale.body": "The route no longer has current endpoint proof.",
  "guidance.routeStale.action":
    "Refresh and restore the matching selection or registration.",
  "guidance.queueStalled.title": "Queued delivery is stalled",
  "guidance.queueStalled.body":
    "The oldest accepted message remains queued past half of its delivery deadline.",
  "guidance.queueStalled.action":
    "Run embassy status. Do not resend accepted work; Embassy still tracks it until settlement or expiry.",
  "guidance.queueStalled.busy":
    "This Codex-bound queue reaches the recipient only after its current turn ends. If you control that recipient, end the turn.",
  "guidance.recipientWaitingInput.title": "Mailbox reached; recipient remains unobserved",
  "guidance.recipientWaitingInput.body":
    "Embassy wrote the message to the recipient mailbox, and the recipient session is currently not observed.",
  "guidance.recipientWaitingInput.action":
    "Check the recipient session in its own window. Do not resend the accepted message.",
  "guidance.unconfirmed.title": "Delivery could not be confirmed",
  "guidance.unconfirmed.body":
    "The local transport write completed, but terminal native evidence was unavailable when the attempt settled.",
  "guidance.unconfirmed.action":
    "Inspect the recipient before retrying; a retry could duplicate the message.",
  "guidance.degraded.title": "The exchange is degraded",
  "guidance.degraded.body":
    "Embassy retained a normalized connector warning.",
  "guidance.degraded.action":
    "Run embassy status. If a broker restart is necessary, queued mail survives and resumes exactly once; only a write in flight at the crash settles ambiguous.",
  "guidance.generic.title": "Embassy reported a normalized alert",
  "guidance.generic.body":
    "This safe code has no automatic repair mapped in the dashboard.",
  "guidance.generic.action":
    "Review embassy status. Never automatically retry an ambiguous delivery.",
  "guidance.codexSuccessionBusy.title": "Codex task change needs a quiet boundary",
  "guidance.codexSuccessionBusy.body":
    "Embassy kept the current Codex registration because accepted or active work had not fully drained.",
  "guidance.codexSuccessionBusy.action":
    "Let current work reach a terminal state, run embassy status, then retry the same register-codex --alias <new> --succeeds <old> command.",
  "guidance.codexSuccessionRecovery.title":
    "Codex task change requires manual recovery",
  "guidance.codexSuccessionRecovery.body":
    "The task change did not reach a safe active generation. Embassy keeps Codex registration offline instead of guessing which task owns the route.",
  "guidance.codexSuccessionRecovery.action":
    "Do not send, retry the task change, or assume either task is active. Run embassy status and preserve the current state for manual recovery.",
  "guidance.progressWatch.title": "A tracked conversation is quiet",
  "guidance.progressWatch.body":
    "Embassy is supervising this completion-ended conversation and has sent at least one idle nudge.",
  "guidance.progressWatch.action":
    "Check the worker route and recent watch history. Either participant can end supervision with exact DONE:; the operator can also run embassy untrack --conversation <token>.",
  "guidance.registryEmpty.title":
    "Claude registry has yielded no parseable record",
  "guidance.registryEmpty.body":
    "No Claude registry record with parseable required fields has been observed since this broker started. If Claude is running, its registry layout may have changed.",
  "guidance.registryEmpty.action":
    "Run embassy refresh-dashboard. If Claude is running and this remains, review the Registry observation in embassy status.",
  "guidance.registryRejected.title": "Claude registry scan reported issues",
  "guidance.registryRejected.body":
    "The latest bounded scan could not read the registry or rejected one or more records. Other records, if any, continue through normal validation.",
  "guidance.registryRejected.action":
    "Run embassy status and review the per-code counts under Registry observation.",
  "transit.eyebrow": "In transit",
  "transit.title": "Queue posture",
  "transit.queued": "Queued messages",
  "transit.active": "Active deliveries",
  "transit.oldest": "Oldest queue age",
  "transit.empty": "No queued messages at snapshot time.",
  "transit.unavailable": "Timestamp unavailable",
  "count.atLeast": "At least {count}",
  "watches.eyebrow": "Progress supervision",
  "watches.title": "Active progress watches",
  "watches.note":
    "Watches end when either participant reports exact DONE:; message bodies and full conversation tokens are omitted.",
  "watches.empty": "No conversation is being supervised.",
  "watches.column.conversation": "Conversation",
  "watches.column.parties": "Owner → worker",
  "watches.column.quietFor": "Quiet for",
  "watches.column.nextAction": "Next check",
  "watches.column.nudges": "Nudges",
  "watches.history.title": "Recent watch history",
  "watches.event.opened": "Opened by TRACK:",
  "watches.event.replaced": "Replaced by a newer TRACK:",
  "watches.event.settled": "Settled",
  "watches.actor.owner": "Owner",
  "watches.actor.worker": "Worker",
  "watches.actor.operator": "Operator",
  "watches.actor.gateway": "Embassy",
  "watches.actor.unknown": "Unknown actor",
  "watches.reason.done": "exact DONE:",
  "watches.reason.untracked": "operator untrack",
  "watches.reason.idleTimeout": "idle limit reached",
  "watches.reason.pairRemoved": "consent edge removed",
  "watches.reason.endpointRetired": "endpoint retired",
  "watches.reason.trackingDisabled": "tracking disabled",
  "activity.eyebrow": "Activity ledger",
  "activity.title": "Recent delivery evidence",
  "activity.note": "Bodies and provider internals are never included.",
  "activity.empty": "No delivery metadata has been recorded yet.",
  "activity.column.updated": "Updated",
  "activity.column.route": "Route",
  "activity.column.id": "ID",
  "activity.column.result": "Result",
  "activity.column.elapsed": "Elapsed",
  "activity.column.size": "Size",
  "activity.column.history": "Evidence",
  "activity.history.one": "1 stage",
  "activity.history.many": "{count} stages",
  "activity.meaning.delivered":
    "Reached its terminal delivered state. This does not mean the model read or acted on it.",
  "activity.meaning.delivered.toClaude":
    "Embassy wrote the message to Claude's native mailbox immediately; it did not wait for the route to become idle. This does not mean the model read or acted on it.",
  "activity.meaning.delivered.toCodex":
    "Codex App Server accepted the turn. This does not mean the model completed or acted on it.",
  "activity.meaning.delivered.toDeepSeek":
    "DeepSeek accepted the delivery. This does not mean the model completed or acted on it.",
  "activity.meaning.delivered.toGrok":
    "Grok Build accepted the delivery. This does not mean the model completed or acted on it.",
  "activity.meaning.unconfirmed":
    "The transport write completed, but terminal native evidence was unavailable. Inspect the recipient before retrying.",
  "activity.meaning.ambiguous":
    "The outcome is unknown after an uncertain write. Do not retry automatically.",
  "activity.meaning.other": "This is the latest normalized delivery state.",
  "activity.meaning.queued":
    "Waiting locally before a provider write; a busy Claude state alone never causes this. Progress, not success.",
  "activity.meaning.dispatching":
    "Being handed to the receiving connector. Progress, not success.",
  "activity.meaning.transportWritten":
    "Written to the receiver's transport; the final receipt is still pending. Progress, not success.",
  "activity.meaning.held":
    "The write landed; the receiver is holding it behind its own approval gate.",
  "activity.meaning.duplicate":
    "A duplicate of an already-accepted message. This copy was never accepted.",
  "activity.meaning.rejected":
    "Refused before acceptance — for example an invalid deadline or a full queue. It never entered the queue.",
  "activity.meaning.senderNotPaired":
    "The configured pairing policy refused this sender; no message body was accepted.",
  "activity.meaning.failed":
    "Settled as failed. The safe code names the cause; never retry an ambiguous delivery automatically.",
  "activity.meaning.expired":
    "The delivery deadline passed before any transport write was observed.",
  "activity.meaning.cancelled":
    "Cancelled by an explicit operation before settlement.",
  "activity.meaning.abandoned.controllerRestarted":
    "The broker stopped before settlement — by design; nothing transfers across restarts.",
  "activity.meaning.abandoned.transientBody":
    "The in-memory message body became unavailable before dispatch.",
  "activity.meaning.abandoned.routeTerminated":
    "Its route was unregistered before the delivery settled.",
  "activity.meaning.abandoned.generic":
    "Settled as abandoned before completion; see the safe code.",
  "direction.claudeToCodex": "Claude → Codex",
  "direction.codexToClaude": "Codex → Claude",
  "delivery.queued": "Queued",
  "delivery.duplicate": "Duplicate",
  "delivery.dispatching": "Dispatching",
  "delivery.transportWritten": "Transport written",
  "delivery.held": "Held",
  "delivery.delivered": "Delivered",
  "delivery.unconfirmed": "Unconfirmed",
  "delivery.failed": "Failed",
  "delivery.ambiguous": "Ambiguous",
  "delivery.expired": "Expired",
  "delivery.cancelled": "Cancelled",
  "delivery.abandoned": "Abandoned",
  "delivery.rejected": "Rejected",
  "sessions.eyebrow": "Sessions & routes",
  "sessions.title": "Accreditation register",
  "sessions.note": "Public aliases only; native identifiers are omitted.",
  "sessions.peers.title": "Discovered Claude sessions",
  "sessions.peers.empty": "No Claude sessions are visible in this snapshot.",
  "sessions.peers.caption": "Discovered Claude sessions and selection state",
  "sessions.routes.title": "Message routes",
  "sessions.routes.empty": "No routes are registered or selected.",
  "sessions.routes.caption": "Registered and selected message routes",
  "column.alias": "Alias",
  "column.host": "Host",
  "column.provider": "Provider",
  "column.state": "State",
  "column.selection": "Selection",
  "column.validation": "Validation",
  "status.validated": "Validated",
  "status.validationRejected": "Rejected",
  "column.queue": "Queue",
  "column.observed": "Observed",
  "column.issue": "Issue",
  "diagnostics.title": "System details",
  "diagnostics.note": "Pinned protocols, counters, and bounded-display notes",
  "diagnostics.connectors": "Connectors",
  "diagnostics.connectors.empty": "No connector metadata is available.",
  "diagnostics.connectors.caption": "Local provider connector status",
  "diagnostics.registry.title": "Registry observation",
  "diagnostics.registry.entriesScanned": "Entries scanned",
  "diagnostics.registry.parseableRecords":
    "Records with parseable required fields",
  "diagnostics.registry.rejected": "Rejected records by safe code",
  "diagnostics.registry.rejectedNone": "None",
  "diagnostics.registry.rejectedCodesOmitted":
    "{count} additional rejection codes omitted",
  "diagnostics.registry.state.parseableRecordObserved":
    "Parseable required fields observed",
  "diagnostics.registry.state.emptySinceBoot": "Empty since broker start",
  "diagnostics.registry.state.noParseableRecordSinceBoot":
    "No parseable record since broker start",
  "diagnostics.protocol": "Protocol",
  "diagnostics.health": "Health",
  "diagnostics.accounting": "Accounting snapshot",
  "diagnostics.accepted": "Accepted",
  "diagnostics.duplicates": "Duplicates",
  "diagnostics.delivered": "Delivered",
  "diagnostics.unconfirmed": "Unconfirmed",
  "diagnostics.ambiguous": "Ambiguous",
  "diagnostics.failed": "Failed",
  "diagnostics.expired": "Expired",
  "diagnostics.cancelled": "Cancelled",
  "diagnostics.abandoned": "Abandoned",
  "diagnostics.rejected": "Rejected",
  "diagnostics.bytesAccepted": "Bytes accepted",
  "diagnostics.queuedBytes": "Bytes queued",
  "diagnostics.omissions": "Bounded display",
  "diagnostics.omissions.none": "Nothing omitted.",
  "diagnostics.omissions.connectors": "{count} connectors",
  "diagnostics.omissions.peers": "{count} sessions",
  "diagnostics.omissions.routes": "{count} routes",
  "diagnostics.omissions.consentEdges": "{count} consent edges",
  "diagnostics.omissions.progressWatches": "{count} progress watches",
  "diagnostics.omissions.upstreamProgressWatchEvents":
    "{count} watch events before dashboard projection",
  "diagnostics.omissions.progressWatchEvents": "{count} watch history rows",
  "diagnostics.omissions.upstreamMessageEvents":
    "{count} delivery events before dashboard projection",
  "diagnostics.omissions.messageGroups": "{count} delivery groups",
  "diagnostics.omissions.messageEvents": "{count} evidence rows",
  "diagnostics.omissions.upstreamAlerts":
    "{count} alerts before dashboard projection",
  "diagnostics.omissions.attentionItems": "{count} attention items",
  "diagnostics.omissions.upstreamActivityEvents":
    "{count} operator-action rows before dashboard projection",
  "diagnostics.omissions.activityEvents": "{count} operator-action rows",
  "provider.claude": "Claude",
  "provider.codex": "Codex",
  "provider.deepseek": "DeepSeek",
  "provider.grok": "Grok Build",
  "health.offline": "Offline",
  "health.connecting": "Connecting",
  "health.healthy": "Healthy",
  "health.degraded": "Degraded",
  "health.meaning.healthy": "Connected and exchanging heartbeats.",
  "health.meaning.connecting": "Establishing the local connection.",
  "health.meaning.degraded": "Connected with retained warnings.",
  "health.meaning.offline": "Not reachable on this machine.",
  "route.stale": "Stale",
  "route.idle": "Idle",
  "route.busy": "Busy",
  "route.awaitingApproval": "Awaiting approval",
  "route.offline": "Offline",
  "route.disabled": "Disabled",
  "route.meaning.idle": "Enabled and ready to carry messages.",
  "route.meaning.busy": "Claude-bound messages still write to the native mailbox immediately; ordinary Codex-bound messages queue for idle.",
  "route.meaning.awaitingApproval":
    "Waiting on the provider's native approval.",
  "route.meaning.stale": "No current endpoint proof; refresh and restore it.",
  "route.meaning.offline": "The route's connector is unreachable.",
  "route.meaning.disabled": "Administratively disabled; not a fault.",
  "peer.idle": "Idle",
  "peer.busy": "Busy",
  "peer.awaitingApproval": "Awaiting approval",
  "peer.offline": "Offline",
  "peer.meaning.idle": "Live and selectable.",
  "peer.meaning.busy": "Live but mid-turn.",
  "peer.meaning.awaitingApproval": "Waiting on native approval.",
  "peer.meaning.offline":
    "Discovered earlier, not currently live — a candidate, not an error.",
  "peer.reason.aliasCollision":
    "Alias collision: rename one Claude session, then refresh discovery.",
  "peer.reason.sessionCollision":
    "Session identity collision: close the duplicate session record, then refresh discovery.",
  "peer.reason.discoveryIncomplete":
    "Discovery was incomplete. Refresh after Claude Code finishes publishing its session inventory.",
  "peer.reason.offline": "This session is not currently live.",
  "time.atSnapshot": "At snapshot",
  "time.beforeSnapshot": "{age} before snapshot",
  "time.afterSnapshot": "{age} after snapshot",
  "time.unavailable": "—",
  "time.ago": "{duration} ago",
  "live.title": "Embassy — live dashboard",
  "live.noscript":
    "This live view requires JavaScript. The static gateway-dashboard.html in the state directory remains the offline floor.",
  "live.label": "Live companion",
  "live.mastheadSubtitle":
    "Live metadata stream with bounded route-consent controls. serve remains socket-only.",
  "live.readonlyFooter":
    "This view can pair, unpair, refresh Claude discovery, and request removal of a stale Codex registration — nothing else.",
  "live.action.authorityLabel": "Bounded operator authority",
  "live.action.authorityBody":
    "This view can pair or unpair named endpoints, refresh Claude discovery, and request removal of a named Codex registration only when the broker proves it stale on a dead endpoint generation. It cannot register tasks, send, reply, approve, interrupt, or change settings.",
  "live.action.sectionTitle": "Bounded route actions",
  "live.action.scope":
    "Pair or unpair named Claude and Codex endpoints, refresh discovery, or recover an orphaned Codex alias. Every action requires confirmation and broker-side revalidation.",
  "live.action.pair": "Pair endpoints",
  "live.action.unpair": "Unpair endpoints",
  "live.action.removeStaleCodexRegistration": "Remove stale registration",
  "live.action.refresh": "Refresh discovery",
  "live.action.confirm": "Confirm",
  "live.action.cancel": "Cancel",
  "live.action.pending": "Working…",
  "live.action.succeeded": "Completed · {code}",
  "live.action.failed": "Not completed · {code}",
  "live.action.requiresConnected":
    "Reconnect to current broker state before using this action.",
  "live.connection.connecting": "Connecting…",
  "live.connection.connected": "Stream connected",
  "live.connection.unavailable": "Observer unavailable — retrying",
  "live.connection.capacity":
    "4 live dashboard windows are already open — close one, then reconnect",
  "live.connection.disconnected": "Connection ended — use Reconnect",
  "live.connection.fatal": "Dashboard session unavailable",
  "live.connection.paused": "Updates paused",
  "live.connection.stopped": "Dashboard stopped",
  "live.control.pause": "Pause",
  "live.control.reconnect": "Reconnect",
  "live.control.refresh": "Read now",
  "live.filter.placeholder": "Filter aliases and activity",
  "live.metric.queued": "Queued",
  "live.metric.active": "Active",
  "live.attention.empty": "No active attention items.",
  "live.activity.empty": "No delivery metadata yet.",
  "live.sessions.title": "Sessions",
  "live.diagnostics.title": "Diagnostics",
  "live.metric.revision": "Stream revision",
  "live.stream.reset": "Source restarted; view resynchronized.",
  "live.http.badRequest": "Bad request.",
  "live.http.forbidden": "Forbidden.",
  "live.http.notFound": "Not found.",
  "live.http.methodNotAllowed": "Method not allowed.",
  "live.http.bodyTooLarge": "Request body too large.",
  "live.http.targetTooLarge": "Request target too large.",
  "live.http.unsupportedMediaType": "Unsupported media type.",
  "live.http.tooManyStreams":
    "4 live dashboard windows are already open. Close one, then reconnect.",
  "live.http.headersTooLarge": "Request headers too large.",
  "live.http.snapshotUnavailable": "Dashboard snapshot unavailable.",
  "live.http.requestFailed": "Request failed.",
  "live.http.starting": "Dashboard is starting.",
  "app.tab.overview": "Overview",
  "app.tab.deliveries": "Deliveries",
  "app.tab.routes": "Routes & Sessions",
  "app.tab.activity": "Activity",
  "app.tab.diagnostics": "Diagnostics",
  "app.search.label": "Search aliases, message suffixes, and safe codes",
  "app.search.placeholder": "Search — Enter opens Deliveries",
  "app.asOf": "as of {time}",
  "app.stale":
    "No new frame for {age}. What you see may no longer be current.",
  "app.missedFrames":
    "Stream frames were missed. The view was re-read from the current snapshot.",
  "app.lowerBound": "At least {count}; the display is bounded.",
  "app.copy": "Copy",
  "app.copied": "Copied",
  "app.copyFailed": "Copy failed — select the text instead",
  "app.staleQuiet": "Connected; nothing has changed for {age}.",
  "app.notLanded.title": "Not in this build",
  "app.notLanded.body":
    "The live contract does not carry this yet, so there is no control here to press. Use the command below instead.",
  "app.show": "Show",
  "app.hide": "Hide",
  "app.overview.statusStrip": "System status",
  "app.overview.broker": "Broker",
  "app.overview.claudeConn": "Claude connector",
  "app.overview.codexConn": "Codex connector",
  "app.overview.connectorMissing": "No connector reported",
  "app.overview.node.claude.title": "claude",
  "app.overview.node.claude.sub": "sessions",
  "app.overview.node.codex.title": "codex",
  "app.overview.node.codex.sub": "tasks",
  "app.overview.count.codex":
    "{ready} ready · {total} registered",
  "app.overview.noPair.title": "No consent edge",
  "app.overview.noPair.body":
    "Paired inbound accepts only senders connected to a registered Codex task by an explicit edge; Codex routes only along explicit edges.",
  "app.overview.degradedEdge":
    "One shown consent edge is not ready.",
  "app.overview.degradedEdges":
    "Some consent edges remain but are not ready.",
  "app.overview.queueC2x": "Claude → Codex",
  "app.overview.queueX2c": "Claude ← Codex",
  "app.overview.depth": "depth",
  "app.overview.oldest": "oldest",
  "app.overview.pulse.title": "Activity pulse — terminal states, last hour",
  "app.overview.pulse.caption":
    "Counted from retained delivery groups only; older evidence has been dropped.",
  "app.overview.pulse.empty": "No delivery settled in the last hour.",
  "app.overview.viewIn": "View in Deliveries",
  "app.deliveries.title": "Deliveries",
  "app.deliveries.caption": "Retained delivery groups, most recent first",
  "app.deliveries.dir.label": "Direction",
  "app.deliveries.dir.all": "All",
  "app.deliveries.dir.codexToClaude": "Claude ← Codex",
  "app.deliveries.fromProvider": "From provider",
  "app.deliveries.toProvider": "To provider",
  "app.deliveries.providerAll": "All providers",
  "app.deliveries.view.label": "View",
  "app.deliveries.view.byRoute": "By route pair",
  "app.deliveries.view.flat": "Flat list",
  "app.deliveries.state.all": "All",
  "app.deliveries.search": "Search suffix, alias, or safe code",
  "app.deliveries.noMatch": "No delivery matches this filter. Send one with",
  "app.deliveries.pickRow": "Select a delivery to trace its lifecycle.",
  "app.deliveries.lifecycle": "Lifecycle",
  "app.deliveries.frames": "Diagnostic frames",
  "app.deliveries.noFrames": "No safe code was recorded for this delivery.",
  "app.deliveries.raw": "raw",
  "app.deliveries.hideRaw": "hide raw",
  "app.deliveries.bodyLabel": "Message body",
  "app.deliveries.bodiesNote":
    "No body retained for this delivery.",
  "app.deliveries.noConv":
    "The live contract carries no conversation token, so deliveries are grouped by route pair instead of by thread.",
  "app.deliveries.eventsTruncated":
    "{count} earlier transitions were dropped by the retention budget.",
  "app.deliveries.earliestRetained": "Earliest retained event",
  "app.routes.topology": "Consent topology",
  "app.routes.candidates": "Candidates",
  "app.routes.claudeSessions": "Claude sessions",
  "app.routes.codexRoutes": "Codex tasks",
  "app.routes.pairs": "Consent edges",
  "app.routes.pairDescription": "Consent edge: {claude} ↔ {codex}",
  "app.routes.unpairedProvider": "{provider}: {count} ready without an edge",
  "app.routes.consentEndpoint": "{provider} · {alias}",
  "app.routes.consentEdge": "{left} ↔ {right}",
  "app.routes.pairState.degraded": "Degraded",
  "app.routes.pairState.unavailable": "Unavailable",
  "app.routes.pairDegradedReason":
    "Consent edge retained; one or both routes need attention.",
  "app.routes.pairUnavailableReason":
    "Consent edge retained; one or both saved route records are unavailable in this snapshot.",
  "app.routes.pairSummary": "Ready: {ready} · Consent edges: {total}",
  "app.routes.unpairedSummary":
    "{claude} ready Claude endpoints and {codex} ready Codex endpoints have no consent edge.",
  "app.routes.pairCmd.consequence":
    "Create consent only between {claude} and {codex}. Existing edges stay unchanged.",
  "app.routes.unpairCmd.consequence":
    "Remove consent only between {claude} and {codex}. Work on adjacent edges stays active.",
  "app.routes.selectCmd.title": "Create a consent edge",
  "app.routes.selectCmd.consequence":
    "Create one consent edge between this Claude session and a Codex task. Other edges stay unchanged.",
  "app.routes.selectCmd.consequenceOpen":
    "Create one outbound destination edge. Open inbound still accepts any live Claude session under this OS user.",
  "app.routes.unselectCmd.consequence":
    "Remove only this consent edge. Work on adjacent edges stays active.",
  "app.routes.unselectCmd.consequenceOpen":
    "Remove only this outbound edge. Open inbound remains enabled for every live Claude session under this OS user.",
  "app.routes.refreshCmd":
    "Re-read local discovery and rewrite the static dashboard file.",
  "app.routes.removeStaleCodex.consequence":
    "Remove only {alias} if the broker confirms that the registration is stale and its endpoint generation is dead. Its consent edges are removed; a live registration is never touched.",
  "app.routes.noPeers": "No Claude session was discovered in this snapshot.",
  "app.routes.noCodex": "No Codex task is registered.",
  "app.routes.successions": "Succession history",
  "app.routes.successions.empty": "No task change is in progress.",
  "app.routes.successions.note":
    "A task change moves the alias to a new Codex task. Nothing transfers: queued work, history, and approvals stay with the old task.",
  "app.routes.detail.absent": "Not carried by the live contract.",
  "app.routes.expandDetails": "Expand details for {alias}",
  "app.routes.collapseDetails": "Collapse details for {alias}",
  "app.routes.queueDepth": "Queue depth",
  "app.routes.counters": "Route counters",
  "app.routes.registered": "registered",
  "app.routes.registerHint":
    "Registration is not a button: it must run inside the Codex task to inherit its identity. Ask your agent to run:",
  "app.routes.noPairInline":
    "no consent edge — pair a Claude session with a Codex task",
  "app.omitted.pairs": "{count} additional consent edges are omitted.",
  "app.activity.title": "Event stream — bounded, most recent first",
  "app.activity.kinds.all": "All kinds",
  "app.activity.kinds.delivery": "Delivery",
  "app.activity.kinds.operation": "Operator action",
  "app.activity.kinds.alert": "Alert",
  "app.activity.operation.discoveryRefreshed": "Discovery refreshed",
  "app.activity.operation.claudeSelected": "Claude session selected",
  "app.activity.operation.claudeUnselected": "Claude session unselected",
  "app.activity.operation.codexRegistered": "Codex task registered",
  "app.activity.operation.codexSucceeded": "Codex registration succeeded",
  "app.activity.operation.codexUnregistered": "Codex task unregistered",
  "app.activity.operation.routesPaired": "Consent edge paired",
  "app.activity.operation.routesUnpaired": "Consent edge unpaired",
  "app.activity.operation.watchEnded": "Progress watch ended",
  "app.activity.operation.endpointRefreshed": "Codex endpoint refreshed",
  "app.activity.operation.codexOrphanRemoved": "Stale Codex registration removed",
  "app.activity.operation.operator": "operator",
  "app.activity.operation.automatic": "automatic",
  "app.activity.operation.accepted": "accepted",
  "app.activity.operation.rejected": "rejected",
  "app.activity.limited":
    "The operator-action ledger lasts for this broker process. Operator-action rows carry no message bodies; Deliveries shows retained bodies by design. Full capability tokens are never shown.",
  "app.activity.empty":
    "Nothing in this window. Events appear as the broker produces them; try",
  "app.diag.versions": "Connector protocols",
  "app.diag.versions.caption":
    "Local connectors with observed protocol state",
  "app.diag.col.provider": "Provider",
  "app.diag.col.host": "Host",
  "app.diag.col.protocol": "Protocol",
  "app.diag.col.version": "Version",
  "app.diag.versions.rangeAbsent":
    "Connector rows show observed protocol tokens and current health.",
  "app.diag.lease.title": "Lease / instance",
  "app.diag.lease.absent":
    "Lease state is not carried by the live contract. Read the local posture with the command below.",
  "app.diag.limits": "Limits & pressure",
  "app.diag.limits.hint":
    "The configured value is not exposed by the live contract. Set the environment variable, then start embassy serve again.",
  "app.diag.deadline.title": "Delivery deadline",
  "app.diag.deadline.body":
    "{count} deliveries have expired since this broker started.",
  "app.diag.deadline.retained":
    "Retained evidence: {terminal} terminal attempts, {expired} expired; configured deadline {deadline}.",
  "app.diag.deadline.bucket.under1m": "under 1 minute",
  "app.diag.deadline.bucket.1to5m": "1–5 minutes",
  "app.diag.deadline.bucket.5to15m": "5–15 minutes",
  "app.diag.deadline.bucket.15to60m": "15–60 minutes",
  "app.diag.deadline.bucket.over60m": "over 60 minutes",
  "app.diag.queue.title": "Queue depth",
  "app.diag.queue.body": "{count} messages are queued right now.",
  "app.diag.bytes.title": "Message byte budget",
  "app.diag.bytes.body":
    "{queued} queued right now; {accepted} accepted since this broker started.",
  "app.diag.steering.title": "Steering",
  "app.diag.steering.absent":
    "STEER markers identify classified Claude-to-Codex delivery evidence. The operator kill-switch setting is not exposed by this metadata contract.",
  "app.diag.deliveryNotices.title": "Delivery notices",
  "app.diag.deliveryNotices.note":
    "Use merged (default), verbose, or quiet; restart embassy serve after changing it.",
  "app.diag.editable.title": "Settings",
  "app.diag.editable.note":
    "Settings are read from environment variables when embassy serve starts. This page cannot change them, so none of them is shown as an editable control.",
  "app.diag.counters": "Accounting counters",
  "app.diag.counters.caption":
    "Lifetime accounting counters for this broker process",
  "app.diag.omissions": "Bounded display",
  "app.diag.omissions.caption": "Rows omitted before display, by category",
  footer:
    "Read-only metadata snapshot. No scripts, mutation controls, external assets, telemetry, or network requests.",
} satisfies DashboardCopy;
