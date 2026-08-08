import assert from "node:assert/strict";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { test } from "node:test";
import os from "node:os";
import path from "node:path";

import {
  DASHBOARD_ALERT_LIMIT,
  DASHBOARD_FILE_NAME,
  DASHBOARD_AVAILABLE_PEER_LIMIT,
  DASHBOARD_CONNECTOR_LIMIT,
  DASHBOARD_MAX_HTML_BYTES,
  DASHBOARD_MESSAGE_LIMIT,
  DASHBOARD_ROUTE_LIMIT,
  escapeDashboardHtml,
  renderDashboardHtml,
  writeDashboardSnapshot,
  type DashboardSnapshot,
} from "../src/gateway/dashboard.js";

function exampleSnapshot(): DashboardSnapshot {
  return {
    schemaVersion: 1,
    generatedAt: "2026-08-07T16:30:00.000Z",
    health: "healthy",
    connectors: [
      {
        provider: "codex",
        host: "this-mac",
        health: "healthy",
        compatibility: "compatible",
        protocol: "app-server/1",
        protocolVersion: "1",
        lastSeenAt: "2026-08-07T16:29:59.000Z",
      },
      {
        provider: "claude",
        host: "this-mac",
        health: "healthy",
        compatibility: "compatible",
        protocol: "peer/1",
        protocolVersion: "1",
        lastSeenAt: "2026-08-07T16:29:59.000Z",
      },
    ],
    availablePeers: [
      {
        alias: "claude-advisor@this-mac",
        provider: "claude",
        host: "this-mac",
        state: "busy",
        compatibility: "compatible",
        selected: true,
        lastSeenAt: "2026-08-07T16:29:59.000Z",
      },
      {
        alias: "review-peer@this-mac",
        provider: "claude",
        host: "this-mac",
        state: "idle",
        compatibility: "compatible",
        selected: false,
        lastSeenAt: "2026-08-07T16:29:58.000Z",
      },
    ],
    routes: [
      {
        alias: "reviewer@this-mac",
        provider: "codex",
        host: "this-mac",
        enabled: true,
        state: "idle",
        compatibility: "compatible",
        busyPolicy: "queue",
        lastSeenAt: "2026-08-07T16:29:58.000Z",
        queueDepth: 2,
        counters: {
          accepted: 4,
          delivered: 3,
          failed: 0,
          ambiguous: 0,
          expired: 0,
          cancelled: 0,
          abandoned: 0,
          rejected: 0,
          bytesAccepted: 342,
        },
      },
      {
        alias: "claude-advisor@this-mac",
        provider: "claude",
        host: "this-mac",
        enabled: true,
        state: "busy",
        compatibility: "compatible",
        busyPolicy: "queue",
        lastSeenAt: "2026-08-07T16:29:57.000Z",
        queueDepth: 0,
        counters: {
          accepted: 1,
          delivered: 1,
          failed: 0,
          ambiguous: 0,
          expired: 0,
          cancelled: 0,
          abandoned: 0,
          rejected: 0,
          bytesAccepted: 120,
        },
      },
    ],
    messages: [
      {
        sequence: 1,
        direction: "claude_to_codex",
        sourceAlias: "claude-advisor@this-mac",
        targetAlias: "reviewer@this-mac",
        messageIdSuffix: "a1b2c3",
        state: "delivered",
        timestamp: "2026-08-07T16:29:56.000Z",
        latencyMs: 18,
        bytes: 342,
        hopCount: 0,
        safeErrorCode: "DELIVERED",
      },
    ],
    accounting: {
      accepted: 4,
      duplicates: 0,
      delivered: 3,
      failed: 0,
      ambiguous: 0,
      expired: 0,
      cancelled: 0,
      abandoned: 0,
      rejected: 0,
      bytesAccepted: 462,
      queuedBytes: 0,
    },
    alerts: [],
    truncation: {
      connectors: 0,
      availablePeers: 0,
      routes: 0,
      messages: 0,
      alerts: 0,
    },
  };
}

test("dashboard rendering is branded, deterministic, static, and self-contained", () => {
  const snapshot = exampleSnapshot();
  const first = renderDashboardHtml(snapshot, { refreshSeconds: 7 });
  const second = renderDashboardHtml(snapshot, { refreshSeconds: 7 });

  assert.equal(first, second);
  assert.match(first, /^<!doctype html>/);
  assert.match(first, /<meta http-equiv="refresh" content="7">/);
  assert.match(first, /Content-Security-Policy/);
  assert.match(first, /<main id="main">/);
  assert.match(first, /<title>Embassy<\/title>/);
  assert.match(first, /<h1>Embassy<\/h1>/);
  assert.match(first, /Local agent gateway/);
  assert.match(first, /metadata-only snapshot/);
  assert.match(first, /color-scheme" content="light dark"/);
  assert.match(first, /@media \(prefers-color-scheme: dark\)/);
  assert.match(first, /@media \(forced-colors: active\)/);
  assert.match(first, /@media \(max-width: 640px\)/);
  assert.match(
    first,
    /<caption>Discovered Claude sessions and explicit selection state<\/caption>/,
  );
  assert.match(
    first,
    /<caption>Messages grouped from bounded normalized delivery events<\/caption>/,
  );
  assert.match(first, />Selected<\/span>/);
  assert.equal(first.includes("Agent Gateway Monitor"), false);
  assert.equal(first.includes("Local, private snapshot"), false);
  assert.equal(first.includes("CODEX_POLICY_MONITOR_ONLY"), false);
  assert.equal(first.includes("CODEX_WORKSPACE_UNATTESTED"), false);
  assert.equal(first.includes("workspace attestation needs renewal"), false);
  assert.equal(first.includes("genuine"), false);
  assert.equal(first.includes("<script"), false);
  assert.equal(first.includes("javascript:"), false);
  assert.equal(first.includes("http://"), false);
  assert.equal(first.includes("https://"), false);
  assert.equal(first.includes("localStorage"), false);
  assert.equal(first.includes("sessionStorage"), false);
  assert.equal(first.includes("document.cookie"), false);
  assert.ok(Buffer.byteLength(first, "utf8") <= DASHBOARD_MAX_HTML_BYTES);

  const paused = renderDashboardHtml(snapshot, { refreshSeconds: 0 });
  assert.equal(paused.includes('http-equiv="refresh"'), false);
  assert.match(paused, /Automatic reload is paused/);
  assert.match(paused, /Status is accurate at snapshot time/);
});

test("dashboard reports explicit projection omissions and progress states", () => {
  const snapshot = exampleSnapshot();
  snapshot.truncation.availablePeers = 12;
  snapshot.truncation.messages = 34;
  snapshot.messages[0]!.state = "transport_written";
  const written = renderDashboardHtml(snapshot);
  assert.match(
    written,
    /Bounded display:<\/strong> omitted 12 Claude sessions, 34 delivery records\./,
  );
  assert.ok(written.includes("Transport written"));
  assert.match(written, /status--info[^>]*>.*Transport written/s);
  snapshot.messages[0]!.state = "held";
  assert.ok(renderDashboardHtml(snapshot).includes(">Held</span>"));
});

test("dashboard summarizes asymmetric directional readiness", () => {
  const html = renderDashboardHtml(exampleSnapshot());

  assert.match(html, /Broker at snapshot/);
  assert.match(html, /Codex \u2192 Claude/);
  assert.match(html, /Selected Claude destination/);
  assert.match(html, /1<\/strong> of <strong>2<\/strong> discovered sessions selected/);
  assert.match(html, /Claude \u2192 Codex/);
  assert.match(html, /Registered Codex targets/);
  assert.match(html, /1<\/strong> of <strong>1<\/strong> targets ready/);
  assert.match(
    html,
    /Every compatible live Claude session running as the same OS user can see each registered Codex target/,
  );
  assert.match(html, /status--info[^>]*>.*Busy/s);
  assert.equal(html.includes("Gateway</dt>"), false);
  assert.equal(html.includes("Selected agents"), false);
});

test("dashboard renders actionable first-run states", () => {
  const missingRoutes = exampleSnapshot();
  missingRoutes.routes = [];
  const routesHtml = renderDashboardHtml(missingRoutes);
  assert.match(routesHtml, /No Claude session is selected/);
  assert.match(routesHtml, /embassy select-claude --alias &lt;alias&gt;/);
  assert.match(routesHtml, /No Codex tasks registered/);
  assert.match(routesHtml, /Inside the Codex task/);
  assert.match(routesHtml, /embassy register-codex --alias &lt;name&gt;@&lt;host&gt;/);

  const noClaude = exampleSnapshot();
  noClaude.availablePeers = [];
  noClaude.routes = noClaude.routes.filter((route) => route.provider === "codex");
  const noClaudeHtml = renderDashboardHtml(noClaude);
  assert.match(noClaudeHtml, /No Claude sessions discovered/);
  assert.match(noClaudeHtml, /crossSessionInbound/);
  assert.match(noClaudeHtml, /embassy refresh-dashboard/);

  const incompatible = exampleSnapshot();
  incompatible.routes = incompatible.routes.filter(
    (route) => route.provider === "codex",
  );
  incompatible.availablePeers = incompatible.availablePeers.map((peer) => ({
    ...peer,
    state: "incompatible" as const,
    compatibility: "incompatible" as const,
    selected: false,
  }));
  assert.match(
    renderDashboardHtml(incompatible),
    /Claude sessions need a compatible version/,
  );
});

test("dashboard escapes every public string and rejects free-form codes", () => {
  const payload = `alias<&"'>PAYLOAD_END`;
  const snapshot = exampleSnapshot();
  snapshot.routes = [
    {
      alias: payload,
      provider: "codex",
      host: `<img src=x onerror="HOST_ATTACK">`,
      enabled: true,
      state: "idle",
      compatibility: "compatible",
      busyPolicy: "queue",
      queueDepth: 0,
      lastSeenAt: "not-a-timestamp<TIME_ATTACK>",
      counters: {
        accepted: 0,
        delivered: 0,
        failed: 0,
        ambiguous: 0,
        expired: 0,
        cancelled: 0,
        abandoned: 0,
        rejected: 0,
        bytesAccepted: 0,
      },
    },
  ];
  snapshot.connectors = [
    {
      provider: "codex",
      host: payload,
      health: "degraded",
      compatibility: "compatible",
      protocol: `peer/1"><img src=x onerror=PROTOCOL_ATTACK>`,
      protocolVersion: "1",
      safeErrorCode: "not safe <RAW_DIAGNOSTIC>",
    },
  ];
  snapshot.availablePeers = [
    {
      alias: `peer<&"'>PEER_DISCOVERY_ATTACK`,
      provider: "claude",
      host: "this-mac",
      state: "idle",
      compatibility: "compatible",
      selected: false,
    },
  ];
  snapshot.messages = [
    {
      sequence: 1,
      direction: "codex_to_claude",
      sourceAlias: payload,
      targetAlias: `<svg onload="MESSAGE_ATTACK">`,
      messageIdSuffix: `LEAK_THIS_SUFFIX`,
      state: "failed",
      timestamp: "2026-08-07T16:29:56.000Z",
      bytes: 12,
      hopCount: 0,
      safeErrorCode: "DELIVERY_FAILED",
    },
  ];
  snapshot.alerts = [
    {
      code: "REOBSERVATION_REQUIRED",
      severity: "warning",
      timestamp: "2026-08-07T16:29:56.000Z",
      provider: "codex",
      host: "this-mac",
      alias: payload,
    },
  ];

  const html = renderDashboardHtml(snapshot);
  assert.equal(html.includes(payload), false);
  assert.ok(html.includes(escapeDashboardHtml(payload)));
  assert.equal(html.includes(`<img src=x onerror="HOST_ATTACK">`), false);
  assert.ok(html.includes("&lt;img src=x onerror=&quot;HOST_ATTACK&quot;&gt;"));
  assert.equal(html.includes("PROTOCOL_ATTACK"), false);
  assert.equal(html.includes("TIME_ATTACK"), false);
  assert.equal(html.includes("RAW_DIAGNOSTIC"), false);
  assert.equal(html.includes("PEER_DISCOVERY_ATTACK"), false);
  assert.equal(html.includes(`<svg onload="MESSAGE_ATTACK">`), false);
  assert.ok(html.includes("&lt;svg onload=&quot;MESSAGE_ATTACK&quot;&gt;"));
  assert.equal(html.includes("LEAK_THIS_SUFFIX"), false);
  assert.ok(html.includes("DELIVERY_FAILED"));
  assert.match(html, /embassy register-codex --alias &lt;alias&gt;/);
});

test("dashboard allowlist omits native identifiers, content, paths, and diagnostics", () => {
  const snapshot = exampleSnapshot() as DashboardSnapshot &
    Record<string, unknown>;
  snapshot["nativeThreadId"] = "THREAD_ID_SECRET";
  snapshot["cwd"] = "CWD_SECRET";
  snapshot["rawError"] = "GATEWAY_RAW_ERROR_SECRET";
  snapshot.connectors = [
    {
      ...snapshot.connectors[0]!,
      socketPath: "SOCKET_PATH_SECRET",
      pid: "PID_SECRET",
      stderr: "CONNECTOR_STDERR_SECRET",
    } as (typeof snapshot.connectors)[number],
  ];
  snapshot.availablePeers = [
    {
      ...snapshot.availablePeers[0]!,
      targetId: "PEER_TARGET_ID_SECRET",
      pid: "PEER_PID_SECRET",
      cwd: "PEER_CWD_SECRET",
      socketPath: "PEER_SOCKET_SECRET",
      registryPayload: "PEER_REGISTRY_SECRET",
    } as (typeof snapshot.availablePeers)[number],
  ];
  snapshot.routes = [
    {
      ...snapshot.routes[0]!,
      sessionId: "SESSION_ID_SECRET",
      title: "TITLE_SECRET",
      configuration: "CONFIG_SECRET",
      routeHandle: "ROUTE_HANDLE_SECRET",
      generation: "GENERATION_SECRET",
    } as (typeof snapshot.routes)[number],
  ];
  snapshot.messages = [
    {
      ...snapshot.messages[0]!,
      messageId: "FULL_MESSAGE_ID_SECRET",
      body: "MESSAGE_BODY_SECRET",
      prompt: "PROMPT_SECRET",
      output: "MODEL_OUTPUT_SECRET",
      toolInput: "TOOL_INPUT_SECRET",
      toolOutput: "TOOL_OUTPUT_SECRET",
      rawError: "RAW_ERROR_SECRET",
    } as (typeof snapshot.messages)[number],
  ];

  const html = renderDashboardHtml(snapshot);
  for (const sentinel of [
    "THREAD_ID_SECRET",
    "CWD_SECRET",
    "GATEWAY_RAW_ERROR_SECRET",
    "SOCKET_PATH_SECRET",
    "PID_SECRET",
    "CONNECTOR_STDERR_SECRET",
    "PEER_TARGET_ID_SECRET",
    "PEER_PID_SECRET",
    "PEER_CWD_SECRET",
    "PEER_SOCKET_SECRET",
    "PEER_REGISTRY_SECRET",
    "SESSION_ID_SECRET",
    "TITLE_SECRET",
    "CONFIG_SECRET",
    "ROUTE_HANDLE_SECRET",
    "GENERATION_SECRET",
    "FULL_MESSAGE_ID_SECRET",
    "MESSAGE_BODY_SECRET",
    "PROMPT_SECRET",
    "MODEL_OUTPUT_SECRET",
    "TOOL_INPUT_SECRET",
    "TOOL_OUTPUT_SECRET",
    "RAW_ERROR_SECRET",
  ]) {
    assert.equal(html.includes(sentinel), false, sentinel);
  }
});

test("dashboard maps safe alerts to inert, actionable guidance", () => {
  const snapshot = exampleSnapshot();
  snapshot.routes[0] = {
    ...snapshot.routes[0]!,
    state: "stale",
    compatibility: "expired",
    safeErrorCode: "REOBSERVATION_REQUIRED",
  };
  snapshot.alerts = [
    {
      code: "REOBSERVATION_REQUIRED",
      severity: "warning",
      timestamp: "2026-08-07T16:29:58.000Z",
      provider: "codex",
      host: "this-mac",
      alias: "reviewer@this-mac",
    },
    {
      code: "UNMAPPED_SAFE_ALERT",
      severity: "info",
      timestamp: "2026-08-07T16:29:57.000Z",
      provider: "claude",
      host: "this-mac",
    },
  ];

  const html = renderDashboardHtml(snapshot);
  assert.match(html, /Action required/);
  assert.match(html, /REOBSERVATION_REQUIRED/);
  assert.match(html, /Codex registration must be observed again/);
  assert.match(
    html,
    /embassy register-codex --alias reviewer@this-mac/,
  );
  assert.match(html, /inside that exact Codex task/i);
  assert.match(html, /UNMAPPED_SAFE_ALERT/);
  assert.match(html, /no automatic repair mapped/);
  assert.match(html, /Do not retry an ambiguous delivery automatically/);
});

test("dashboard groups message lifecycles without conflating matching suffixes", () => {
  const snapshot = exampleSnapshot();
  snapshot.messages = [
    {
      sequence: 1,
      direction: "claude_to_codex",
      sourceAlias: "claude-advisor@this-mac",
      targetAlias: "reviewer@this-mac",
      messageIdSuffix: "a1b2c3",
      state: "queued",
      timestamp: "2026-08-07T16:29:50.000Z",
      bytes: 342,
      hopCount: 0,
    },
    {
      sequence: 2,
      direction: "claude_to_codex",
      sourceAlias: "claude-advisor@this-mac",
      targetAlias: "reviewer@this-mac",
      messageIdSuffix: "a1b2c3",
      state: "dispatching",
      timestamp: "2026-08-07T16:29:51.000Z",
      latencyMs: 1_000,
      bytes: 342,
      hopCount: 0,
    },
    {
      sequence: 3,
      direction: "claude_to_codex",
      sourceAlias: "claude-advisor@this-mac",
      targetAlias: "reviewer@this-mac",
      messageIdSuffix: "a1b2c3",
      state: "delivered",
      timestamp: "2026-08-07T16:29:52.000Z",
      latencyMs: 2_000,
      bytes: 342,
      hopCount: 0,
    },
    {
      sequence: 4,
      direction: "codex_to_claude",
      sourceAlias: "reviewer@this-mac",
      targetAlias: "claude-advisor@this-mac",
      messageIdSuffix: "a1b2c3",
      state: "failed",
      timestamp: "2026-08-07T16:29:49.000Z",
      latencyMs: 500,
      bytes: 120,
      hopCount: 0,
      safeErrorCode: "CODEX_DELIVERY_FAILED",
    },
  ];

  const html = renderDashboardHtml(snapshot);
  assert.equal(
    (html.match(/data-dashboard-row="message-summary"/g) ?? []).length,
    2,
  );
  assert.equal(
    (html.match(/data-dashboard-row="message-event"/g) ?? []).length,
    3,
  );
  assert.match(
    html,
    /data-dashboard-row="message-summary"[\s\S]*?Claude \u2192 Codex[\s\S]*?Delivered[\s\S]*?2\.0 s[\s\S]*?<\/tr>/,
  );
  const queuedIndex = html.indexOf(">Queued</span>");
  const dispatchingIndex = html.indexOf(">Dispatching</span>");
  const deliveredIndex = html.lastIndexOf(">Delivered</span>");
  assert.ok(
    queuedIndex >= 0 &&
      dispatchingIndex > queuedIndex &&
      deliveredIndex > dispatchingIndex,
  );
});

test("message timeline is capped and keeps the newest grouped metadata", () => {
  const snapshot = exampleSnapshot();
  snapshot.messages = Array.from(
    { length: DASHBOARD_MESSAGE_LIMIT + 5 },
    (_, index) => ({
      sequence: index + 1,
      direction: "claude_to_codex" as const,
      sourceAlias: `agent-${String(index).padStart(4, "0")}`,
      targetAlias: "reviewer@this-mac",
      messageIdSuffix: index.toString(16).padStart(6, "0"),
      state: "delivered" as const,
      timestamp: new Date(Date.UTC(2026, 7, 7, 12, 0, index)).toISOString(),
      latencyMs: index,
      bytes: index + 1,
      hopCount: 0,
    }),
  );

  const html = renderDashboardHtml(snapshot);
  assert.equal(
    (html.match(/data-dashboard-row="message-summary"/g) ?? []).length,
    DASHBOARD_MESSAGE_LIMIT,
  );
  assert.equal(html.includes("agent-0000"), false);
  assert.equal(html.includes("agent-0004"), false);
  assert.ok(html.includes("agent-0005"));
  assert.ok(
    html.includes(
      `agent-${String(DASHBOARD_MESSAGE_LIMIT + 4).padStart(4, "0")}`,
    ),
  );
  assert.match(html, /omitted 5 delivery records/);
  assert.ok(Buffer.byteLength(html, "utf8") <= DASHBOARD_MAX_HTML_BYTES);
});

test("available peer inventory is bounded and remains Claude-only", () => {
  const snapshot = exampleSnapshot();
  snapshot.availablePeers = Array.from(
    { length: DASHBOARD_AVAILABLE_PEER_LIMIT + 2 },
    (_, index) => ({
      alias: `peer${String(index).padStart(4, "0")}@this-mac`,
      provider: "claude" as const,
      host: "this-mac",
      state: "idle" as const,
      compatibility: "compatible" as const,
      selected: false,
      lastSeenAt: "2026-08-07T16:29:59.000Z",
    }),
  );

  const html = renderDashboardHtml(snapshot);
  assert.match(
    html,
    new RegExp(`${DASHBOARD_AVAILABLE_PEER_LIMIT + 2} discovered`),
  );
  assert.match(html, /omitted 2 Claude sessions/);
  assert.ok(html.includes("peer0000@this-mac"));
  assert.ok(
    html.includes(
      `peer${String(DASHBOARD_AVAILABLE_PEER_LIMIT - 1).padStart(4, "0")}@this-mac`,
    ),
  );
  assert.equal(
    html.includes(
      `peer${String(DASHBOARD_AVAILABLE_PEER_LIMIT).padStart(4, "0")}@this-mac`,
    ),
    false,
  );
  assert.equal(
    html.includes(
      `peer${String(DASHBOARD_AVAILABLE_PEER_LIMIT + 1).padStart(4, "0")}@this-mac`,
    ),
    false,
  );

  snapshot.availablePeers = [
    {
      alias: "codex-peer@this-mac",
      provider: "codex",
      host: "this-mac",
      state: "idle",
      compatibility: "compatible",
      selected: false,
    },
  ];
  const rejected = renderDashboardHtml(snapshot);
  assert.equal(rejected.includes("codex-peer@this-mac"), false);
  assert.match(rejected, /No Claude sessions are currently visible to Embassy/);
  assert.ok(rejected.includes("reviewer@this-mac"));
});

test("dense valid snapshots remain bounded and disclose local display caps", () => {
  const snapshot = exampleSnapshot();
  const routeTemplate = snapshot.routes[0]!;
  snapshot.connectors = Array.from(
    { length: DASHBOARD_CONNECTOR_LIMIT + 2 },
    (_, index) => ({
      ...snapshot.connectors[index % snapshot.connectors.length]!,
      host: `host-${String(index).padStart(2, "0")}.local`,
    }),
  );
  snapshot.availablePeers = Array.from(
    { length: DASHBOARD_AVAILABLE_PEER_LIMIT + 2 },
    (_, index) => ({
      alias: `peer${String(index).padStart(4, "0")}@host.local`,
      provider: "claude" as const,
      host: "host.local",
      state: "idle" as const,
      compatibility: "compatible" as const,
      selected: index === 0,
    }),
  );
  snapshot.routes = Array.from(
    { length: DASHBOARD_ROUTE_LIMIT + 2 },
    (_, index) => ({
      ...routeTemplate,
      alias: `route${String(index).padStart(4, "0")}@host.local`,
      provider: index % 2 === 0 ? ("codex" as const) : ("claude" as const),
      host: "host.local",
      queueDepth: 0,
    }),
  );
  snapshot.messages = Array.from(
    { length: DASHBOARD_MESSAGE_LIMIT + 2 },
    (_, index) => ({
      sequence: index + 1,
      timestamp: new Date(Date.UTC(2026, 7, 7, 15, 0, index)).toISOString(),
      messageIdSuffix: index.toString(16).padStart(6, "0"),
      direction: "claude_to_codex" as const,
      sourceAlias: `peer${String(index).padStart(4, "0")}@host.local`,
      targetAlias: `route${String(index).padStart(4, "0")}@host.local`,
      state: "delivered" as const,
      bytes: 16_384,
      hopCount: 0,
      latencyMs: 2_000,
    }),
  );
  snapshot.alerts = Array.from(
    { length: DASHBOARD_ALERT_LIMIT + 2 },
    (_, index) => ({
      code: "UNMAPPED_SAFE_ALERT",
      severity: "warning" as const,
      timestamp: "2026-08-07T16:29:59.000Z",
      provider: index % 2 === 0 ? ("codex" as const) : ("claude" as const),
      host: "host.local",
      alias: `route${String(index).padStart(4, "0")}@host.local`,
    }),
  );

  const html = renderDashboardHtml(snapshot);
  assert.ok(Buffer.byteLength(html, "utf8") <= DASHBOARD_MAX_HTML_BYTES);
  assert.match(html, /omitted 2 connectors/);
  assert.match(html, /2 Claude sessions/);
  assert.match(html, /2 routes/);
  assert.match(html, /2 delivery records/);
  assert.match(html, /2 alerts/);
});

test("publisher atomically replaces a mode-0600 snapshot in private state", async () => {
  const root = await mkdtemp(
    path.join(await realpath(os.tmpdir()), "gateway-dashboard-test-"),
  );
  const stateDirectory = path.join(root, "state");
  try {
    await mkdir(stateDirectory, { mode: 0o700 });
    await chmod(stateDirectory, 0o700);
    const first = exampleSnapshot();
    const outputPath = await writeDashboardSnapshot(stateDirectory, first);
    assert.equal(outputPath, path.join(stateDirectory, DASHBOARD_FILE_NAME));
    assert.equal((await lstat(outputPath)).mode & 0o777, 0o600);
    assert.equal(await readFile(outputPath, "utf8"), renderDashboardHtml(first));
    assert.deepEqual(await readdir(stateDirectory), [DASHBOARD_FILE_NAME]);

    const replacement = exampleSnapshot();
    replacement.health = "degraded";
    replacement.alerts = [
      {
        code: "HOST_STALE",
        severity: "warning",
        timestamp: "2026-08-07T16:30:00.000Z",
        provider: "codex",
        host: "this-mac",
      },
    ];
    await writeDashboardSnapshot(stateDirectory, replacement);
    const body = await readFile(outputPath, "utf8");
    assert.ok(body.includes("Degraded"));
    assert.ok(body.includes("HOST_STALE"));
    assert.equal((await lstat(outputPath)).mode & 0o777, 0o600);
    assert.deepEqual(await readdir(stateDirectory), [DASHBOARD_FILE_NAME]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("publisher rejects public or symlinked state and an existing symlink target", async () => {
  const root = await mkdtemp(
    path.join(await realpath(os.tmpdir()), "gateway-dashboard-unsafe-"),
  );
  const privateDirectory = path.join(root, "private");
  const publicDirectory = path.join(root, "public");
  const linkedDirectory = path.join(root, "linked");
  try {
    await mkdir(privateDirectory, { mode: 0o700 });
    await chmod(privateDirectory, 0o700);
    await mkdir(publicDirectory, { mode: 0o755 });
    await chmod(publicDirectory, 0o755);
    await symlink(privateDirectory, linkedDirectory);

    await assert.rejects(
      writeDashboardSnapshot(publicDirectory, exampleSnapshot()),
      { message: "DASHBOARD_STATE_DIRECTORY_UNSAFE" },
    );
    await assert.rejects(
      writeDashboardSnapshot(linkedDirectory, exampleSnapshot()),
      { message: "DASHBOARD_STATE_DIRECTORY_UNSAFE" },
    );

    const outside = path.join(root, "outside.html");
    await writeFile(outside, "preserve me", { mode: 0o600 });
    await symlink(outside, path.join(privateDirectory, DASHBOARD_FILE_NAME));
    await assert.rejects(
      writeDashboardSnapshot(privateDirectory, exampleSnapshot()),
      { message: "DASHBOARD_TARGET_UNSAFE" },
    );
    assert.equal(await readFile(outside, "utf8"), "preserve me");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
