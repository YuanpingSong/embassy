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
  DASHBOARD_FILE_NAME,
  DASHBOARD_AVAILABLE_PEER_LIMIT,
  DASHBOARD_MAX_HTML_BYTES,
  DASHBOARD_MESSAGE_LIMIT,
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

test("dashboard rendering is deterministic, static, and self-contained", () => {
  const snapshot = exampleSnapshot();
  const first = renderDashboardHtml(snapshot, { refreshSeconds: 7 });
  const second = renderDashboardHtml(snapshot, { refreshSeconds: 7 });

  assert.equal(first, second);
  assert.match(first, /^<!doctype html>/);
  assert.match(first, /<meta http-equiv="refresh" content="7">/);
  assert.match(first, /Content-Security-Policy/);
  assert.match(first, /<main id="main">/);
  assert.match(
    first,
    /<caption>Available genuine Claude peers and selection state<\/caption>/,
  );
  assert.match(first, /<caption>Bounded normalized delivery metadata<\/caption>/);
  assert.match(first, /Available Claude peers<\/span><span class="metric__value">2<\/span>/);
  assert.match(first, />Selected<\/span>/);
  assert.equal(first.includes("<script"), false);
  assert.equal(first.includes("javascript:"), false);
  assert.equal(first.includes("http://"), false);
  assert.equal(first.includes("https://"), false);
  assert.equal(first.includes("localStorage"), false);
  assert.equal(first.includes("sessionStorage"), false);
  assert.equal(first.includes("document.cookie"), false);
  assert.ok(Buffer.byteLength(first, "utf8") <= DASHBOARD_MAX_HTML_BYTES);

  const claudeIndex = first.indexOf("claude-advisor@this-mac");
  const reviewerIndex = first.indexOf("reviewer@this-mac");
  assert.ok(claudeIndex >= 0 && reviewerIndex > claudeIndex);
});

test("dashboard reports explicit projection omissions and progress states", () => {
  const snapshot = exampleSnapshot();
  snapshot.truncation.availablePeers = 12;
  snapshot.truncation.messages = 34;
  snapshot.messages[0]!.state = "transport_written";
  const written = renderDashboardHtml(snapshot);
  assert.match(
    written,
    /Bounded snapshot:<\/strong> omitted 12 available peers, 34 messages\./,
  );
  assert.ok(written.includes("Transport written"));
  snapshot.messages[0]!.state = "held";
  assert.ok(renderDashboardHtml(snapshot).includes(">Held</span>"));
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

test("message timeline is capped and keeps the newest normalized metadata", () => {
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
  assert.equal((html.match(/<td>Claude \u2192 Codex<\/td>/g) ?? []).length, 100);
  assert.equal(html.includes("agent-0000</td>"), false);
  assert.equal(html.includes("agent-0004</td>"), false);
  assert.ok(html.includes("agent-0005</td>"));
  assert.ok(html.includes("agent-0104</td>"));
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
    /Available Claude peers<\/span><span class="metric__value">130<\/span>/,
  );
  assert.ok(html.includes("peer0000@this-mac"));
  assert.ok(html.includes("peer0127@this-mac"));
  assert.equal(html.includes("peer0128@this-mac"), false);
  assert.equal(html.includes("peer0129@this-mac"), false);

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
  assert.match(
    rejected,
    /Available Claude peers<\/span><span class="metric__value">0<\/span>/,
  );
  assert.ok(rejected.includes("reviewer@this-mac"));
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
