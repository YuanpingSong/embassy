import assert from "node:assert/strict";
import { test } from "node:test";

import { renderDashboardHtml } from "../src/gateway/dashboard.js";
import {
  buildDashboardViewModel,
  buildLiveDashboardViewModel,
  DASHBOARD_MODEL_LIMITS,
} from "../src/gateway/dashboard-model.js";
import { dashboardFixture, routeCounters } from "./dashboard-fixture.js";
import {
  certifiedCompatibilityVersions,
  compatibilityProbeNames,
  evaluateCompatibilityAttestation,
  type CompatibilityProbeResult,
} from "../src/gateway/compatibility.js";
import { projectPublicCompatibilityCheck } from "../src/gateway/types.js";

test("static projection never materializes message bodies while live projection does", () => {
  const snapshot = dashboardFixture();
  snapshot.messages = snapshot.messages.map((message) => ({
    ...message,
    body: "STATIC_BODY_SENTINEL",
  }));

  const staticModel = buildDashboardViewModel(snapshot);
  const liveModel = buildLiveDashboardViewModel(snapshot);
  assert.equal(staticModel.activity.some((group) => "body" in group), false);
  assert.equal(
    liveModel.activity.some((group) => group.body === "STATIC_BODY_SENTINEL"),
    true,
  );
  assert.equal(renderDashboardHtml(snapshot).includes("STATIC_BODY_SENTINEL"), false);
});

test("snapshot evidence exposes suffix-only correlation, peer validation, operations, and deadline buckets", () => {
  const snapshot = dashboardFixture();
  const model = buildDashboardViewModel(snapshot);
  assert.equal(model.peers.every((peer) => peer.validated), true);
  assert.equal(model.activity[0]?.conversationIdSuffix, "IjKl_789");
  assert.deepEqual(model.brokerActivity, [
    {
      sequence: 1,
      timestamp: "2026-08-08T11:59:54.000Z",
      kind: "pairing",
      action: "routes_paired",
      outcome: "accepted",
      aliases: ["claude-advisor@this-mac", "codex-reviewer@this-mac"],
      operatorAction: true,
    },
  ]);
  assert.equal(model.deadlinePressure?.configuredDeadlineMs, 300_000);
  assert.equal(model.deadlinePressure?.buckets[0]?.settled, 3);

  const en = renderDashboardHtml(snapshot, { locale: "en" });
  const zh = renderDashboardHtml(snapshot, { locale: "zh-CN" });
  assert.match(en, /conv …IjKl_789/);
  assert.match(en, /Consent edge paired/);
  assert.match(en, /Validated/);
  assert.match(en, /Retained evidence: 3 terminal attempts/);
  assert.match(zh, /已建立同意边/);
  assert.match(zh, /已验证/);
  assert.match(zh, /保留证据：3 次终局尝试/);
  assert.equal(en.includes("conv_IjKl_789"), false);
});

test("activity projection distinguishes automatic endpoint refresh from operator recovery", () => {
  const snapshot = dashboardFixture();
  snapshot.activityEvents = [
    {
      sequence: 1,
      timestamp: "2026-08-08T11:59:53.000Z",
      kind: "endpoint",
      action: "endpoint_refreshed",
      outcome: "accepted",
      aliases: ["codex-reviewer@this-mac"],
      operatorAction: false,
    },
    {
      sequence: 2,
      timestamp: "2026-08-08T11:59:54.000Z",
      kind: "recovery",
      action: "codex_orphan_removed",
      outcome: "accepted",
      aliases: ["codex-orphan@this-mac"],
      operatorAction: true,
    },
  ];

  const model = buildDashboardViewModel(snapshot);
  assert.deepEqual(
    model.brokerActivity.map(({ action, operatorAction }) => ({
      action,
      operatorAction,
    })),
    [
      { action: "endpoint_refreshed", operatorAction: false },
      { action: "codex_orphan_removed", operatorAction: true },
    ],
  );

  const en = renderDashboardHtml(snapshot, { locale: "en" });
  const zh = renderDashboardHtml(snapshot, { locale: "zh-CN" });
  assert.equal(
    (en.match(/data-dashboard-row="automatic-event"/gu) ?? []).length,
    1,
  );
  assert.equal(
    (en.match(/data-dashboard-row="operator-action"/gu) ?? []).length,
    1,
  );
  assert.match(en, /automatic[\s\S]*Codex endpoint refreshed/u);
  assert.match(en, /operator[\s\S]*Stale Codex registration removed/u);
  assert.match(zh, /自动[\s\S]*已刷新 Codex 端点/u);
  assert.match(zh, /操作者[\s\S]*已移除陈旧的 Codex 注册/u);
});

test("diagnostics reduce compatibility to automatic provider safety rows", () => {
  const snapshot = dashboardFixture();
  snapshot.compatibilityChecks = (["claude", "codex"] as const).map(
    (surface) => {
      const probes: CompatibilityProbeResult[] = compatibilityProbeNames[
        surface
      ].map((name) => ({
        name,
        outcome: "pass" as const,
      }));
      if (surface === "claude") {
        probes[2] = {
          name: "registry_schema",
          outcome: "fail",
          safeErrorCode: "CLAUDE_REGISTRY_SCHEMA_REJECTED",
        };
      }
      return projectPublicCompatibilityCheck(
        evaluateCompatibilityAttestation({
          surface,
          version: certifiedCompatibilityVersions[surface][0]!,
          checkedAt: "2026-08-08T11:58:00.000Z",
          certifiedVersions: certifiedCompatibilityVersions[surface],
          probes,
        }),
      );
    },
  );
  snapshot.alerts = [
    {
      code: "COMPATIBILITY_CERTIFICATION_FAILED",
      severity: "error",
      timestamp: "2026-08-08T11:59:00.000Z",
      provider: "claude",
      host: "this-mac",
    },
  ];
  const model = buildDashboardViewModel(snapshot);
  assert.deepEqual(model.compatibilityChecks[0], {
    surface: "claude",
    version: certifiedCompatibilityVersions.claude[0],
    testedVersion: certifiedCompatibilityVersions.claude[0],
    supportedMajor: "2",
    tier: "incompatible",
    checkedAt: "2026-08-08T11:58:00.000Z",
    failure: "registry_schema",
    safeErrorCode: "CLAUDE_REGISTRY_SCHEMA_REJECTED",
  });
  assert.equal(
    model.attention.some(
      (item) => item.code === "COMPATIBILITY_CERTIFICATION_FAILED",
    ),
    false,
  );
  const en = renderDashboardHtml(snapshot, { locale: "en" });
  const zh = renderDashboardHtml(snapshot, { locale: "zh-CN" });
  assert.match(en, /Provider compatibility/);
  assert.match(en, /Automatic provider compatibility status/);
  assert.match(en, /Tested by this release/);
  assert.match(en, /Supported major/);
  assert.match(en, /Failure/);
  assert.match(en, /CLAUDE_REGISTRY_SCHEMA_REJECTED/);
  assert.equal(en.includes("Live certification"), false);
  assert.equal(en.includes("fail / wire"), false);
  assert.equal(en.includes("COMPATIBILITY_CERTIFICATION_FAILED"), false);
  assert.match(zh, /提供方兼容性/);
  assert.equal(zh.includes("实时认证"), false);
});

test("unsupported provider majors name bounded evidence while the broker stays usable", () => {
  const snapshot = dashboardFixture();
  snapshot.health = "degraded";
  snapshot.connectors[0] = {
    ...snapshot.connectors[0]!,
    health: "degraded",
    compatibility: "incompatible",
    safeErrorCode: "CLAUDE_PEER_VERSION_UNSUPPORTED",
  };
  const probes: CompatibilityProbeResult[] = compatibilityProbeNames.claude.map(
    (name) => ({
      name,
      outcome: name === "version" ? "fail" : "pass",
      ...(name === "version"
        ? { safeErrorCode: "CLAUDE_PEER_VERSION_UNSUPPORTED" }
        : {}),
    }),
  );
  snapshot.compatibilityChecks = [
    projectPublicCompatibilityCheck(
      evaluateCompatibilityAttestation({
        surface: "claude",
        version: "3.0.0",
        checkedAt: "2026-08-08T11:58:00.000Z",
        certifiedVersions: certifiedCompatibilityVersions.claude,
        probes,
      }),
    ),
  ];
  snapshot.alerts = [
    {
      code: "CLAUDE_PEER_VERSION_UNSUPPORTED",
      severity: "error",
      timestamp: "2026-08-08T11:58:00.000Z",
      provider: "claude",
      host: "this-mac",
    },
  ];

  const model = buildDashboardViewModel(snapshot);
  assert.deepEqual(model.compatibilityChecks[0], {
    surface: "claude",
    version: "3.0.0",
    testedVersion: "2.1.227",
    supportedMajor: "2",
    tier: "incompatible",
    checkedAt: "2026-08-08T11:58:00.000Z",
    failure: "version",
    safeErrorCode: "CLAUDE_PEER_VERSION_UNSUPPORTED",
  });
  assert.equal(
    model.attention.some(
      (item) => item.guidance === "provider_incompatible",
    ),
    true,
  );
  assert.equal(model.exchange.claude.nextAction, "review_compatibility");
  assert.equal(model.exchange.claude.ready, 0);
  assert.equal(model.pairs[0]?.state, "degraded");
  const en = renderDashboardHtml(snapshot, { locale: "en" });
  const zh = renderDashboardHtml(snapshot, { locale: "zh-CN" });
  assert.match(en, /Provider build is write-fenced/);
  assert.match(en, /3\.0\.0[\s\S]*2\.1\.227[\s\S]*>2</u);
  assert.equal(en.includes("embassy health"), false);
  assert.equal(en.includes("Start or keep a Claude Code session running"), false);
  assert.equal(en.includes("Refresh discovery"), false);
  assert.equal(en.includes("Restart only when"), false);
  assert.match(zh, /提供方构建已禁止写入/);
  assert.match(zh, /3\.0\.0[\s\S]*2\.1\.227/u);
});

test("monitor-only Codex is non-ready everywhere without registration retry advice", () => {
  const snapshot = dashboardFixture();
  const codexRoute = snapshot.routes.find((route) => route.provider === "codex");
  assert.ok(codexRoute);
  codexRoute.safeErrorCode = "CODEX_WRITES_DISABLED";

  const model = buildDashboardViewModel(snapshot);
  assert.equal(model.overall, "attention");
  assert.equal(model.exchange.codex.status, "attention");
  assert.equal(model.exchange.codex.ready, 0);
  assert.equal(model.exchange.codex.monitorOnly, 1);
  assert.equal(model.exchange.codex.nextAction, "review_compatibility");
  assert.equal(model.graph.readyPairCount, 0);
  assert.equal(model.pairs[0]?.state, "degraded");
  assert.equal(
    model.attention.some((item) => item.guidance === "route_stale"),
    false,
  );

  const en = renderDashboardHtml(snapshot, { locale: "en" });
  const zh = renderDashboardHtml(snapshot, { locale: "zh-CN" });
  assert.match(en, />Needs attention</);
  assert.match(en, /1 monitor-only/);
  assert.match(en, /Monitor only — writes are disabled/);
  assert.match(en, /discovery or registration cannot remove this write fence/);
  assert.equal(en.includes("Re-run embassy register-codex"), false);
  assert.match(zh, />需要处理</);
  assert.match(zh, /仅监控 1/);
  assert.match(zh, /仅监控——此路由因 CODEX_WRITES_DISABLED 而停用写入/);
  assert.equal(zh.includes("重新运行 embassy register-codex"), false);
});

test("provider quarantine owns recovery and suppresses normal-route noise", () => {
  const snapshot = dashboardFixture();
  snapshot.health = "degraded";
  const claudeConnector = snapshot.connectors.find(
    (connector) => connector.provider === "claude",
  );
  const claudeRoute = snapshot.routes.find((route) => route.provider === "claude");
  assert.ok(claudeConnector);
  assert.ok(claudeRoute);
  claudeConnector.health = "degraded";
  claudeConnector.compatibility = "incompatible";
  claudeConnector.safeErrorCode = "CLAUDE_MESSAGING_SOCKET_SCHEMA_REJECTED";
  claudeRoute.enabled = false;
  claudeRoute.state = "incompatible";
  claudeRoute.compatibility = "incompatible";
  claudeRoute.safeErrorCode = "CLAUDE_MESSAGING_SOCKET_SCHEMA_REJECTED";
  snapshot.availablePeers = [];
  snapshot.alerts = [{
    code: "CLAUDE_MESSAGING_SOCKET_SCHEMA_REJECTED",
    severity: "warning",
    timestamp: "2026-08-08T11:58:00.000Z",
    provider: "claude",
    host: "this-mac",
  }];

  const model = buildDashboardViewModel(snapshot);
  assert.equal(model.exchange.claude.status, "attention");
  assert.equal(model.exchange.claude.ready, 0);
  assert.equal(model.exchange.claude.nextAction, "review_compatibility");
  assert.equal(model.pairs[0]?.state, "degraded");
  assert.deepEqual(
    model.attention.map((item) => item.guidance),
    ["provider_incompatible"],
  );
  const en = renderDashboardHtml(snapshot, { locale: "en" });
  assert.match(en, /Provider build is write-fenced/);
  assert.equal(en.includes("Start or keep a Claude Code session running"), false);
  assert.equal(en.includes("Refresh discovery"), false);
  assert.equal(en.includes("Restart only when"), false);

  const codexConnector = snapshot.connectors.find(
    (connector) => connector.provider === "codex",
  );
  const codexRoute = snapshot.routes.find((route) => route.provider === "codex");
  assert.ok(codexConnector);
  assert.ok(codexRoute);
  codexConnector.health = "degraded";
  codexConnector.compatibility = "incompatible";
  codexConnector.safeErrorCode = "CODEX_INITIALIZE_SCHEMA_REJECTED";
  codexRoute.enabled = false;
  codexRoute.state = "incompatible";
  codexRoute.compatibility = "incompatible";
  codexRoute.safeErrorCode = "CODEX_INITIALIZE_SCHEMA_REJECTED";
  snapshot.alerts.push({
    code: "CODEX_INITIALIZE_SCHEMA_REJECTED",
    severity: "warning",
    timestamp: "2026-08-08T11:58:01.000Z",
    provider: "codex",
    host: "this-mac",
  });

  const both = buildDashboardViewModel(snapshot);
  assert.equal(both.overall, "attention");
  assert.equal(both.exchange.claude.status, "attention");
  assert.equal(both.exchange.codex.status, "attention");
  assert.equal(both.graph.readyPairCount, 0);
  assert.equal(
    both.attention.filter((item) => item.guidance === "provider_incompatible")
      .length,
    2,
  );
  assert.equal(
    both.attention.some((item) => item.guidance === "degraded"),
    false,
  );
});

test("registry evidence stays connector-scoped and raises one honest warning", () => {
  const rejected = dashboardFixture();
  const claude = rejected.connectors.find(
    (connector) => connector.provider === "claude",
  );
  assert.ok(claude);
  claude.registry = {
    entriesScanned: 3,
    parseableRecords: 2,
    parseableRecordSeenSinceBoot: true,
    rejected: [{ safeErrorCode: "REGISTRY_INVALID_SCHEMA", count: 1 }],
    rejectedCodesOmitted: 0,
  };
  const rejectedModel = buildDashboardViewModel(rejected);
  assert.deepEqual(rejectedModel.connectors[0]?.registry, {
    entriesScanned: 3,
    parseableRecords: 2,
    parseableRecordSeenSinceBoot: true,
    rejected: [{ safeErrorCode: "REGISTRY_INVALID_SCHEMA", count: 1 }],
    rejectedCodesOmitted: 0,
  });
  assert.equal(
    rejectedModel.attention.filter(
      (item) => item.code === "CLAUDE_REGISTRY_RECORDS_REJECTED",
    ).length,
    1,
  );
  const rejectedEn = renderDashboardHtml(rejected, { locale: "en" });
  const rejectedZh = renderDashboardHtml(rejected, { locale: "zh-CN" });
  assert.match(rejectedEn, /Registry observation/);
  assert.match(rejectedEn, /REGISTRY_INVALID_SCHEMA/);
  assert.match(rejectedEn, /Parseable required fields observed/);
  assert.match(rejectedEn, /Claude registry scan reported issues/);
  assert.match(rejectedZh, /注册表观察/);
  assert.match(rejectedZh, /Claude 注册表扫描报告了问题/);

  claude.registry = {
    entriesScanned: 0,
    parseableRecords: 0,
    parseableRecordSeenSinceBoot: false,
    rejected: [{ safeErrorCode: "CLAUDE_REGISTRY_UNAVAILABLE", count: 1 }],
    rejectedCodesOmitted: 0,
  };
  claude.health = "degraded";
  claude.compatibility = "incompatible";
  claude.safeErrorCode = "CLAUDE_REGISTRY_UNAVAILABLE";
  const unavailableModel = buildDashboardViewModel(rejected);
  assert.deepEqual(
    unavailableModel.attention.filter(
      (item) => item.code === "CLAUDE_REGISTRY_UNAVAILABLE",
    ),
    [
      {
        kind: "connector",
        code: "CLAUDE_REGISTRY_UNAVAILABLE",
        severity: "warning",
        provider: "claude",
        host: "this-mac",
        guidance: "registry_rejected",
      },
    ],
  );
  const unavailableAttention = renderDashboardHtml(rejected, {
    locale: "en",
  }).match(/<section class="section attention"[\s\S]*?<\/section>/u)?.[0];
  assert.ok(unavailableAttention);
  assert.equal(
    (unavailableAttention.match(/CLAUDE_REGISTRY_UNAVAILABLE/gu) ?? []).length,
    1,
  );
  assert.match(unavailableAttention, /Claude registry scan reported issues/);

  const empty = dashboardFixture();
  const emptyClaude = empty.connectors.find(
    (connector) => connector.provider === "claude",
  );
  assert.ok(emptyClaude);
  emptyClaude.registry = {
    entriesScanned: 0,
    parseableRecords: 0,
    parseableRecordSeenSinceBoot: false,
    rejected: [],
    rejectedCodesOmitted: 0,
  };
  const emptyModel = buildDashboardViewModel(empty);
  assert.equal(
    emptyModel.attention.some(
      (item) => item.code === "CLAUDE_REGISTRY_EMPTY_SINCE_BOOT",
    ),
    true,
  );
  assert.match(
    renderDashboardHtml(empty, { locale: "en" }),
    /No Claude registry record with parseable required fields has been observed since this broker started/,
  );

  emptyClaude.registry.entriesScanned = 2;
  assert.equal(
    buildDashboardViewModel(empty).attention.some(
      (item) =>
        item.code === "CLAUDE_REGISTRY_NO_PARSEABLE_RECORD_SINCE_BOOT",
    ),
    true,
  );

  emptyClaude.registry.parseableRecordSeenSinceBoot = true;
  const previouslyObserved = buildDashboardViewModel(empty);
  assert.equal(
    previouslyObserved.attention.some((item) =>
      item.code?.startsWith("CLAUDE_REGISTRY_") === true
    ),
    false,
  );
});

test("progress watches project bounded countdowns, attention, and bilingual metadata only", () => {
  const snapshot = dashboardFixture();
  snapshot.progressWatches = [
    {
      conversationIdSuffix: "AbCd_123",
      ownerAlias: "claude-advisor@this-mac",
      workerAlias: "codex-reviewer@this-mac",
      lastActivityAt: "2026-08-08T11:55:00.000Z",
      nextActionAt: "2026-08-08T12:05:00.000Z",
      nudgeCount: 1,
    },
  ];
  snapshot.progressWatchEvents = [
    {
      sequence: 12,
      timestamp: "2026-08-08T11:59:30.000Z",
      conversationIdSuffix: "MnOp_345",
      ownerAlias: "claude-advisor@this-mac",
      workerAlias: "codex-reviewer@this-mac",
      kind: "settled",
      actor: "unknown",
      reason: "legacy_done",
    },
    {
      sequence: 11,
      timestamp: "2026-08-08T11:59:00.000Z",
      conversationIdSuffix: "KlMn_012",
      ownerAlias: "claude-advisor@this-mac",
      workerAlias: "codex-reviewer@this-mac",
      kind: "settled",
      actor: "owner",
      reason: "done",
    },
    {
      sequence: 10,
      timestamp: "2026-08-08T11:58:00.000Z",
      conversationIdSuffix: "IjKl_901",
      ownerAlias: "claude-advisor@this-mac",
      workerAlias: "codex-reviewer@this-mac",
      kind: "settled",
      actor: "worker",
      reason: "done",
    },
    {
      sequence: 9,
      timestamp: "2026-08-08T11:57:00.000Z",
      conversationIdSuffix: "GhIj_789",
      ownerAlias: "claude-advisor@this-mac",
      workerAlias: "codex-reviewer@this-mac",
      kind: "settled",
      actor: "operator",
      reason: "pair_removed",
    },
    {
      sequence: 8,
      timestamp: "2026-08-08T11:56:00.000Z",
      conversationIdSuffix: "EfGh_456",
      ownerAlias: "claude-advisor@this-mac",
      workerAlias: "codex-reviewer@this-mac",
      kind: "replaced",
      actor: "owner",
    },
    {
      sequence: 7,
      timestamp: "2026-08-08T11:55:00.000Z",
      conversationIdSuffix: "AbCd_123",
      ownerAlias: "claude-advisor@this-mac",
      workerAlias: "codex-reviewer@this-mac",
      kind: "opened",
      actor: "owner",
    },
  ];
  const model = buildDashboardViewModel(snapshot);
  assert.deepEqual(model.watches[0], {
    conversationIdSuffix: "AbCd_123",
    ownerAlias: "claude-advisor@this-mac",
    workerAlias: "codex-reviewer@this-mac",
    lastActivityAt: "2026-08-08T11:55:00.000Z",
    nextActionAt: "2026-08-08T12:05:00.000Z",
    nudgeCount: 1,
    idleForMs: 300_000,
    dueInMs: 300_000,
  });
  assert.deepEqual(
    model.watchEvents.map(({ kind, actor, reason }) => ({
      kind,
      actor,
      reason,
    })),
    [
      { kind: "settled", actor: "unknown", reason: "legacy_done" },
      { kind: "settled", actor: "owner", reason: "done" },
      { kind: "settled", actor: "worker", reason: "done" },
      { kind: "settled", actor: "operator", reason: "pair_removed" },
      { kind: "replaced", actor: "owner", reason: undefined },
      { kind: "opened", actor: "owner", reason: undefined },
    ],
  );
  assert.equal(
    model.attention.find((item) => item.guidance === "progress_watch")?.code,
    "PROGRESS_WATCH_QUIET",
  );

  const en = renderDashboardHtml(snapshot, { locale: "en" });
  const zh = renderDashboardHtml(snapshot, { locale: "zh-CN" });
  assert.match(en, /Active progress watches/);
  assert.match(en, /either participant reports exact DONE:/);
  assert.equal(en.includes("owner confirmation is still required"), false);
  assert.equal(en.includes("Owner-ended watches only"), false);
  assert.equal(en.includes("data-watch-phase"), false);
  assert.equal(en.includes("Quiet episode"), false);
  assert.equal(en.includes("Conversation anchored"), false);
  assert.match(en, /…AbCd_123/);
  assert.match(zh, /活跃进度监视/);
  assert.match(zh, /任一参与方报告精确的 DONE:/);
  assert.equal(zh.includes("仍需所有者确认"), false);
  for (const secret of ["conv_", "ownerLease", "receiptHandle"]) {
    assert.equal(en.includes(secret), false);
    assert.equal(zh.includes(secret), false);
  }

  snapshot.progressWatches[0]!.nudgeCount = 0;
  assert.equal(
    buildDashboardViewModel(snapshot).attention.some(
      (item) => item.guidance === "progress_watch",
    ),
    false,
  );
});

test("view model derives deterministic route and global queue ages from generatedAt", () => {
  const snapshot = dashboardFixture();
  snapshot.routes.push({
    alias: "claude-queue@this-mac",
    provider: "claude",
    host: "this-mac",
    enabled: true,
    state: "busy",
    compatibility: "compatible",
    busyPolicy: "queue",
    queueDepth: 1,
    oldestQueuedAt: "2026-08-08T11:59:50.000Z",
    counters: routeCounters(),
  });
  const first = buildDashboardViewModel(snapshot);
  const second = buildDashboardViewModel(snapshot);
  assert.deepEqual(first, second);
  assert.equal(first.transit.queuedMessages, 3);
  assert.equal(first.transit.oldestQueueAgeMs, 90_500);
  assert.equal(first.transit.oldestQueuedAt, "2026-08-08T11:58:29.500Z");
  assert.equal(first.routes.find((route) => route.alias === "claude-queue@this-mac")?.queueAgeMs, 10_000);

  const en = renderDashboardHtml(snapshot, { locale: "en" });
  const zh = renderDashboardHtml(snapshot, { locale: "zh-CN" });
  assert.match(en, /1m 30s/);
  assert.match(zh, /1 分 30 秒/);
});

test("malformed, future, and empty-route queue timestamps never leak or become inferred alerts", () => {
  const snapshot = dashboardFixture();
  const { oldestQueuedAt: _oldestQueuedAt, ...routeWithoutTimestamp } =
    snapshot.routes[1]!;
  snapshot.routes = [
    { ...routeWithoutTimestamp, alias: "codex-missing@this-mac" },
    { ...snapshot.routes[1]!, alias: "codex-malformed@this-mac", oldestQueuedAt: `bad\"><script>QUEUE_SECRET</script>` },
    { ...snapshot.routes[1]!, alias: "codex-future@this-mac", oldestQueuedAt: "2026-08-08T12:00:00.001Z" },
    { ...snapshot.routes[1]!, alias: "codex-empty@this-mac", queueDepth: 0, oldestQueuedAt: "2026-08-01T00:00:00.000Z" },
  ];
  snapshot.pairs = [];
  const model = buildDashboardViewModel(snapshot);
  assert.equal(model.transit.queuedMessages, 6);
  assert.equal(model.transit.oldestQueueAgeMs, undefined);
  assert.equal(model.attention.length, 0);
  const html = renderDashboardHtml(snapshot);
  assert.equal(html.includes("QUEUE_SECRET"), false);
  assert.equal(html.includes("QUEUE_STALLED"), false);
  assert.match(html, /Timestamp unavailable/);
});

test("QUEUE_STALLED is rendered only from a provided normalized alert", () => {
  const snapshot = dashboardFixture();
  const route = snapshot.routes.find(
    ({ alias }) => alias === "codex-reviewer@this-mac",
  );
  assert.ok(route);
  route.state = "busy";
  route.queueDepth = 2;
  snapshot.alerts = [{
    code: "QUEUE_STALLED",
    severity: "warning",
    timestamp: "2026-08-08T11:57:30.000Z",
    provider: "codex",
    host: "this-mac",
    alias: "codex-reviewer@this-mac",
    body: "ALERT_BODY_SECRET",
  } as (typeof snapshot.alerts)[number]];
  const model = buildDashboardViewModel(snapshot);
  assert.equal(
    model.attention.find(({ code }) => code === "QUEUE_STALLED")?.queueDepth,
    2,
  );
  const html = renderDashboardHtml(snapshot);
  assert.equal((html.match(/QUEUE_STALLED/g) ?? []).length, 1);
  assert.match(html, /Queued delivery is stalled/);
  assert.match(html, /Codex-bound queue/);
  assert.match(html, /current turn ends/);
  assert.match(html, /Queued messages:<\/strong> 2/);
  assert.equal(html.includes("ALERT_BODY_SECRET"), false);
  assert.match(html, /id="attention-title"/);

  route.state = "idle";
  const idleModel = buildDashboardViewModel(snapshot);
  assert.equal(
    idleModel.attention.find(({ code }) => code === "QUEUE_STALLED")?.queueDepth,
    undefined,
  );
  assert.equal(renderDashboardHtml(snapshot).includes("current turn ends"), false);

  route.state = "busy";
  snapshot.alerts[0]!.provider = "claude";
  assert.equal(
    buildDashboardViewModel(snapshot).attention.find(
      ({ code }) => code === "QUEUE_STALLED",
    )?.queueDepth,
    undefined,
  );
});

test("a durable pair stays visible and degraded when its Codex route needs re-observation", () => {
  const snapshot = dashboardFixture();
  snapshot.routes[1] = {
    ...snapshot.routes[1]!,
    state: "stale",
    compatibility: "expired",
    safeErrorCode: "REOBSERVATION_REQUIRED",
  };
  const model = buildDashboardViewModel(snapshot);
  assert.equal(model.overall, "attention");
  assert.equal(model.graph.pairCount, 1);
  assert.equal(model.graph.readyPairCount, 0);
  assert.equal(model.graph.unpairedReadyClaude, 0);
  assert.equal(model.graph.unpairedReadyCodex, 0);
  assert.equal(model.pairs[0]?.state, "degraded");
  assert.equal(model.exchange.claude.nextAction, "none");
  assert.equal(model.exchange.codex.nextAction, "restore_codex");
  assert.equal(model.attention.length, 1);
  assert.equal(model.attention[0]?.kind, "route");
  assert.equal(model.attention[0]?.guidance, "codex_reactivation_required");
  const html = renderDashboardHtml(snapshot);
  assert.match(html, /Consent edge: claude-advisor@this-mac ↔ codex-reviewer@this-mac/);
  assert.match(html, /Consent edge retained; one or both routes need attention/);
  assert.match(html, /Saved Codex route is not live/);
  assert.match(html, /saved Codex route has no current live endpoint proof/);
  assert.match(
    html,
    /embassy register-codex --alias codex-reviewer@this-mac/,
  );
  assert.match(html, />Degraded</);
  assert.equal(html.includes("No consent edge exists"), false);
  assert.equal(html.includes("QUEUE_STALLED"), false);
});

test("a durable pair stays visible with an unavailable reason when one saved route is absent", () => {
  const snapshot = dashboardFixture();
  snapshot.routes = snapshot.routes.filter(
    (route) => route.alias !== "codex-reviewer@this-mac",
  );

  const model = buildDashboardViewModel(snapshot);
  assert.equal(model.overall, "attention");
  assert.equal(model.graph.pairCount, 1);
  assert.equal(model.graph.readyPairCount, 0);
  assert.equal(model.pairs[0]?.state, "unavailable");
  assert.equal(model.exchange.codex.nextAction, "register_codex");
  assert.equal(model.attention.length, 1);
  assert.deepEqual(model.attention[0], {
    kind: "route",
    severity: "warning",
    provider: "codex",
    alias: "codex-reviewer@this-mac",
    host: "this-mac",
    guidance: "consent_edge_unavailable",
  });

  const en = renderDashboardHtml(snapshot);
  const zh = renderDashboardHtml(snapshot, { locale: "zh-CN" });
  assert.match(en, /Consent edge: claude-advisor@this-mac ↔ codex-reviewer@this-mac/);
  assert.match(en, /Consent edge retained; one or both saved route records are unavailable in this snapshot/);
  assert.match(en, /Consent edge endpoint unavailable/);
  assert.match(en, /Run embassy refresh-dashboard first/);
  assert.match(en, />Unavailable</);
  assert.equal(en.includes("No consent edge exists"), false);
  assert.match(zh, /同意边仍然保留；此快照中缺少一端或两端已保存路由的记录/);
  assert.match(zh, /同意边端点不可用/);
  assert.match(zh, /请先运行 embassy refresh-dashboard/);
  assert.equal(zh.includes("当前没有同意边"), false);
});

test("Codex restart alerts for one route coalesce into one human condition", () => {
  const snapshot = dashboardFixture();
  snapshot.routes[1] = {
    ...snapshot.routes[1]!,
    state: "stale",
    compatibility: "expired",
    safeErrorCode: "REOBSERVATION_REQUIRED",
  };
  snapshot.alerts = [
    {
      code: "REOBSERVATION_REQUIRED",
      severity: "warning",
      timestamp: "2026-08-08T11:59:58.000Z",
      provider: "codex",
      host: "this-mac",
      alias: "codex-reviewer@this-mac",
    },
    {
      code: "CODEX_BOOT_REACTIVATION_SKIPPED",
      severity: "warning",
      timestamp: "2026-08-08T11:59:59.000Z",
      provider: "codex",
      host: "this-mac",
      alias: "codex-reviewer@this-mac",
    },
  ];

  const model = buildDashboardViewModel(snapshot);
  assert.equal(model.attention.length, 1);
  assert.equal(model.attention[0]?.code, "CODEX_BOOT_REACTIVATION_SKIPPED");
  assert.equal(model.attention[0]?.timestamp, "2026-08-08T11:59:59.000Z");
  assert.equal(model.attention[0]?.guidance, "codex_reactivation_required");

  const en = renderDashboardHtml(snapshot);
  const zh = renderDashboardHtml(snapshot, { locale: "zh-CN" });
  assert.match(en, /CODEX_BOOT_REACTIVATION_SKIPPED/);
  assert.match(en, /Saved Codex route is not live/);
  assert.match(en, /saved Codex route has no current live endpoint proof/);
  assert.match(en, /embassy register-codex --alias codex-reviewer@this-mac/);
  assert.match(zh, /已保存的 Codex 路由不在线/);
  assert.match(zh, /当前没有在线端点证明/);
  assert.match(zh, /embassy register-codex --alias codex-reviewer@this-mac/);
});

test("Codex reactivation evidence disappears once its exact route is live", () => {
  const snapshot = dashboardFixture();
  snapshot.alerts = [
    {
      code: "CODEX_BOOT_REACTIVATION_SKIPPED",
      severity: "warning",
      timestamp: "2026-08-08T11:59:59.000Z",
      provider: "codex",
      host: "this-mac",
      alias: "codex-reviewer@this-mac",
    },
  ];

  const model = buildDashboardViewModel(snapshot);
  assert.equal(
    model.attention.some(
      (item) => item.code === "CODEX_BOOT_REACTIVATION_SKIPPED",
    ),
    false,
  );
  assert.equal(
    renderDashboardHtml(snapshot).includes("Saved Codex route is not live"),
    false,
  );
});

test("route-derived reactivation guidance requires an actually stale Codex route", () => {
  const snapshot = dashboardFixture();
  snapshot.routes[1] = {
    ...snapshot.routes[1]!,
    state: "offline",
    compatibility: "expired",
    safeErrorCode: "REOBSERVATION_REQUIRED",
  };

  const model = buildDashboardViewModel(snapshot);
  const routeAttention = model.attention.find(
    (item) => item.alias === "codex-reviewer@this-mac",
  );
  assert.equal(routeAttention?.code, "REOBSERVATION_REQUIRED");
  assert.equal(routeAttention?.guidance, "route_stale");
  assert.equal(
    model.attention.some(
      (item) => item.guidance === "codex_reactivation_required",
    ),
    false,
  );
  assert.equal(
    renderDashboardHtml(snapshot).includes("Saved Codex route is not live"),
    false,
  );
});

test("an aged Claude mailbox write surfaces one notice only while its exact recipient is unobserved", () => {
  const snapshot = dashboardFixture();
  snapshot.routes[0] = {
    ...snapshot.routes[0]!,
    queueDepth: 0,
    lastSeenAt: "2026-08-08T11:56:59.000Z",
    safeErrorCode: "CLAUDE_PEER_NOT_OBSERVED",
  };
  const mailboxWrite = snapshot.messages.find(
    (message) => message.messageIdSuffix === "c0ffee",
  )!;
  mailboxWrite.state = "delivered";
  mailboxWrite.timestamp = "2026-08-08T11:57:00.000Z";
  snapshot.alerts = [
    {
      code: "CLAUDE_PEER_NOT_OBSERVED",
      severity: "warning",
      timestamp: "2026-08-08T11:59:57.000Z",
      provider: "claude",
      alias: "claude-advisor@this-mac",
    },
  ];

  const model = buildDashboardViewModel(snapshot);
  assert.equal(model.attention.length, 1);
  assert.deepEqual(model.attention[0], {
    kind: "route",
    code: "CLAUDE_PEER_NOT_OBSERVED",
    severity: "warning",
    timestamp: "2026-08-08T11:56:59.000Z",
    provider: "claude",
    alias: "claude-advisor@this-mac",
    host: "this-mac",
    guidance: "recipient_waiting_input",
  });
  const en = renderDashboardHtml(snapshot, { locale: "en" });
  const zh = renderDashboardHtml(snapshot, { locale: "zh-CN" });
  assert.match(
    en,
    /Embassy wrote the message to the recipient mailbox, and the recipient session is currently not observed\./,
  );
  assert.match(zh, /Embassy 已将消息写入接收方消息邮箱，且当前未观察到接收方会话。/);
  assert.equal(en.includes("waiting on interactive input"), false);
  const hasMailboxNotice = () =>
    buildDashboardViewModel(snapshot).attention.some(
      ({ guidance }) => guidance === "recipient_waiting_input",
    );

  snapshot.alerts = [];
  mailboxWrite.timestamp = "2026-08-08T11:50:00.000Z";
  snapshot.messages.push({
    ...mailboxWrite,
    messageIdSuffix: "d00dad",
    timestamp: "2026-08-08T11:59:30.000Z",
  });
  // A 30-second-old write to the same recipient is not evidence that the
  // ten-minute-old one was ever read: the oldest write still owns the notice.
  assert.equal(hasMailboxNotice(), true);
  snapshot.messages.pop();
  mailboxWrite.timestamp = "2026-08-08T11:57:00.000Z";

  snapshot.routes[0]!.lastSeenAt = "2026-08-08T11:59:00.000Z";
  delete snapshot.routes[0]!.safeErrorCode;
  assert.equal(buildDashboardViewModel(snapshot).attention.length, 0);

  snapshot.routes[0]!.safeErrorCode = "CLAUDE_PEER_NOT_OBSERVED";
  mailboxWrite.timestamp = "2026-08-08T11:58:01.000Z";
  assert.equal(hasMailboxNotice(), false);
  mailboxWrite.timestamp = "invalid";
  assert.equal(hasMailboxNotice(), false);

  mailboxWrite.timestamp = "2026-08-08T11:57:00.000Z";
  mailboxWrite.targetAlias = "codex-reviewer@this-mac";
  snapshot.routes[1]!.safeErrorCode = "PEER_NOT_OBSERVED";
  assert.equal(hasMailboxNotice(), false);
});

test("restart guidance preserves queued mail and isolates in-flight ambiguity", () => {
  const snapshot = dashboardFixture();
  snapshot.alerts = [
    {
      code: "ADAPTER_DEGRADED",
      severity: "warning",
      timestamp: snapshot.generatedAt,
      provider: "codex",
      host: "this-mac",
    },
  ];
  const html = renderDashboardHtml(snapshot);
  assert.match(html, /queued mail survives and resumes exactly once/);
  assert.match(html, /only a write in flight at the crash settles ambiguous/);
  assert.doesNotMatch(html, /restarting abandons memory-only message bodies/);
});

test("Codex succession alerts distinguish a busy boundary from manual recovery", () => {
  const snapshot = dashboardFixture();
  snapshot.alerts = [
    {
      code: "CODEX_SUCCESSION_BARRIER_BUSY",
      severity: "warning",
      timestamp: snapshot.generatedAt,
      provider: "codex",
      host: "this-mac",
    },
    {
      code: "CODEX_SUCCESSION_PUBLICATION_UNKNOWN",
      severity: "error",
      timestamp: snapshot.generatedAt,
      provider: "codex",
      host: "this-mac",
    },
  ];
  const model = buildDashboardViewModel(snapshot);
  assert.equal(
    model.attention.find(
      (item) => item.code === "CODEX_SUCCESSION_BARRIER_BUSY",
    )?.guidance,
    "codex_succession_busy",
  );
  assert.equal(
    model.attention.find(
      (item) => item.code === "CODEX_SUCCESSION_PUBLICATION_UNKNOWN",
    )?.guidance,
    "codex_succession_recovery",
  );

  const en = renderDashboardHtml(snapshot, { locale: "en" });
  assert.match(en, /Codex task change needs a quiet boundary/);
  assert.match(en, /kept the current Codex registration/);
  assert.match(en, /Codex task change requires manual recovery/);
  assert.match(en, /keeps Codex registration offline instead of guessing/);
  assert.match(en, /Do not send, retry the task change, or assume either task is active/);

  const zh = renderDashboardHtml(snapshot, { locale: "zh-CN" });
  assert.match(zh, /更换 Codex 任务需要等待静默边界/);
  assert.match(zh, /更换 Codex 任务需要手动恢复/);
  assert.match(zh, /不会猜测哪个任务拥有路由/);
});

test("first-run exchange board gives truthful paired setup actions", () => {
  const snapshot = dashboardFixture();
  snapshot.routes = [];
  snapshot.pairs = [];
  snapshot.availablePeers = snapshot.availablePeers.map((peer) => ({
    ...peer,
    selected: false,
  }));
  const visiblePeers = renderDashboardHtml(snapshot);
  assert.match(
    visiblePeers,
    /embassy pair --claude &lt;alias&gt; --codex &lt;alias&gt;/,
  );
  assert.match(visiblePeers, /embassy register-codex --alias codex-&lt;name&gt;@&lt;host&gt;/);

  snapshot.availablePeers = [];
  const noPeers = renderDashboardHtml(snapshot);
  assert.match(noPeers, /Start or keep a Claude Code session running/);
  assert.match(noPeers, /embassy refresh-dashboard/);
  assert.match(noPeers, /No consent edge exists/);
  assert.match(noPeers, /refuse unpaired senders/);
  assert.match(noPeers, /data-inbound-mode="paired"/);

  snapshot.inboundMode = "open";
  const openInbound = renderDashboardHtml(snapshot);
  assert.match(openInbound, /Open inbound/);
  assert.match(
    openInbound,
    /Any live Claude session under this OS user may initiate inbound work/,
  );
  assert.match(openInbound, /data-inbound-mode="open"/);
});

test("dashboard projects explicit consent edges and graph readiness", () => {
  const snapshot = dashboardFixture();
  snapshot.routes.push({
    ...snapshot.routes[0]!,
    alias: "claude-reviewer@this-mac",
    state: "idle",
  });
  const staleCodexRoute = {
    ...snapshot.routes[1]!,
    alias: "codex-builder@this-mac",
    queueDepth: 0,
    state: "stale" as const,
  };
  delete staleCodexRoute.oldestQueuedAt;
  snapshot.routes.push(staleCodexRoute);
  snapshot.pairs.push({
    claudeAlias: "claude-reviewer@this-mac",
    codexAlias: "codex-builder@this-mac",
    host: "this-mac",
    counters: routeCounters({ accepted: 1, failed: 1 }),
  });
  snapshot.truncation.pairs = 2;

  const model = buildDashboardViewModel(snapshot);
  assert.deepEqual(
    model.pairs.map(({ claudeAlias, codexAlias, state }) => ({
      claudeAlias,
      codexAlias,
      state,
    })),
    [
      {
        claudeAlias: "claude-advisor@this-mac",
        codexAlias: "codex-reviewer@this-mac",
        state: "ready",
      },
      {
        claudeAlias: "claude-reviewer@this-mac",
        codexAlias: "codex-builder@this-mac",
        state: "degraded",
      },
    ],
  );
  assert.deepEqual(model.graph, {
    pairCount: 2,
    readyPairCount: 1,
    pairCountIsLowerBound: true,
    unpairedReadyClaude: 0,
    unpairedReadyCodex: 0,
  });
  assert.equal(model.omissions.pairs, 2);
  const html = renderDashboardHtml(snapshot);
  assert.match(html, /Consent edge: claude-advisor@this-mac ↔ codex-reviewer@this-mac/);
  assert.match(html, /Consent edge: claude-reviewer@this-mac ↔ codex-builder@this-mac/);
  assert.match(html, /Ready: At least 1 · Consent edges: At least 4/);
  assert.match(html, /2 additional consent edges are omitted/);
});

test("pair truncation remains evidence of consent even when every edge row is omitted", () => {
  const snapshot = dashboardFixture();
  snapshot.pairs = [];
  snapshot.truncation.pairs = 1;

  const model = buildDashboardViewModel(snapshot);
  assert.deepEqual(model.graph, {
    pairCount: 0,
    readyPairCount: 0,
    pairCountIsLowerBound: true,
    unpairedReadyClaude: 1,
    unpairedReadyCodex: 1,
  });
  assert.equal(model.overall, "ready");
  assert.equal(model.exchange.claude.nextAction, "none");
  assert.equal(model.exchange.codex.nextAction, "none");

  const html = renderDashboardHtml(snapshot);
  assert.match(html, /Ready: At least 0 · Consent edges: At least 1/);
  assert.match(html, /1 additional consent edges are omitted/);
  assert.equal(html.includes("No consent edge exists"), false);
  assert.equal(html.includes("no consent edge —"), false);
});

test("a fresh Codex task remains pairable beside an existing degraded edge", () => {
  const snapshot = dashboardFixture();
  snapshot.routes[1] = {
    ...snapshot.routes[1]!,
    state: "stale",
    compatibility: "expired",
    safeErrorCode: "REOBSERVATION_REQUIRED",
  };
  const { oldestQueuedAt: _oldestQueuedAt, ...freshCodex } =
    dashboardFixture().routes[1]!;
  snapshot.routes.push({
    ...freshCodex,
    alias: "codex-fresh@this-mac",
    state: "idle",
    queueDepth: 0,
  });

  const model = buildDashboardViewModel(snapshot);
  assert.equal(model.pairs[0]?.state, "degraded");
  assert.equal(model.graph.unpairedReadyCodex, 1);
  assert.equal(model.exchange.codex.nextAction, "pair_routes");
  const html = renderDashboardHtml(snapshot);
  assert.equal(html.includes("No consent edge exists"), false);
  assert.match(
    html,
    /0 ready Claude endpoints and 1 ready Codex endpoints have no consent edge/,
  );
});

test("unpaired sender refusal is neutral and explains the pairing boundary", () => {
  const snapshot = dashboardFixture();
  snapshot.messages.push({
    sequence: 5,
    timestamp: "2026-08-08T12:00:00.000Z",
    messageIdSuffix: "bad0ff",
    direction: "claude_to_codex",
    sourceAlias: "claude-unpaired@this-mac",
    targetAlias: "codex-reviewer@this-mac",
    state: "rejected",
    bytes: 42,
    safeErrorCode: "SENDER_NOT_PAIRED",
  });

  const html = renderDashboardHtml(snapshot);
  assert.match(html, /SENDER_NOT_PAIRED/);
  assert.match(html, /configured pairing policy refused this sender/);
  assert.match(
    html,
    /data-delivery-state="rejected">[\s\S]*?status status--quiet[\s\S]*?SENDER_NOT_PAIRED/,
  );
});

test("only compatible live collision-free peers drive the select call to action", () => {
  const snapshot = dashboardFixture();
  snapshot.routes = snapshot.routes.filter((route) => route.provider === "codex");
  snapshot.availablePeers = [
    {
      alias: "claude-collision@this-mac",
      provider: "claude",
      host: "this-mac",
      state: "incompatible",
      compatibility: "incompatible",
      validated: false,
      selected: false,
      safeErrorCode: "PEER_ALIAS_COLLISION",
    },
    {
      alias: "claude-session@this-mac",
      provider: "claude",
      host: "this-mac",
      state: "incompatible",
      compatibility: "incompatible",
      validated: false,
      selected: false,
      safeErrorCode: "PEER_SESSION_COLLISION",
    },
    {
      alias: "claude-incomplete@this-mac",
      provider: "claude",
      host: "this-mac",
      state: "incompatible",
      compatibility: "incompatible",
      validated: false,
      selected: false,
      safeErrorCode: "PEER_DISCOVERY_INCOMPLETE",
    },
    {
      alias: "claude-offline@this-mac",
      provider: "claude",
      host: "this-mac",
      state: "offline",
      compatibility: "compatible",
      validated: false,
      selected: false,
    },
  ];
  const model = buildDashboardViewModel(snapshot);
  assert.equal(model.exchange.claude.selectable, 0);
  assert.equal(model.exchange.claude.nextAction, "repair_claude_inventory");
  assert.equal(model.peers.every((peer) => !peer.selectable), true);
  const html = renderDashboardHtml(snapshot);
  assert.equal(html.includes("embassy select-claude --alias"), false);
  assert.equal((html.match(/>Not selectable<\/span>/g) ?? []).length, 4);
  assert.match(html, /Alias collision: rename one Claude session/);
  assert.match(html, /Session identity collision/);
  assert.match(html, /Discovery was incomplete/);
  assert.match(html, /not currently live/);
});

test("message lifecycles group by direction and route, not suffix alone", () => {
  const snapshot = dashboardFixture();
  snapshot.messages.push({
    sequence: 5,
    timestamp: "2026-08-08T11:59:59.500Z",
    messageIdSuffix: "a1b2c3",
    direction: "codex_to_claude",
    sourceAlias: "codex-reviewer@this-mac",
    targetAlias: "claude-advisor@this-mac",
    state: "failed",
    latencyMs: 500,
    bytes: 42,
    safeErrorCode: "DELIVERY_FAILED",
  });
  const model = buildDashboardViewModel(snapshot);
  assert.equal(model.activity.length, 4);
  const delivered = model.activity.find((message) => message.state === "delivered");
  assert.equal(delivered?.events.length, 2);
  const html = renderDashboardHtml(snapshot);
  assert.equal((html.match(/data-dashboard-row="message-summary"/g) ?? []).length, 4);
  assert.equal((html.match(/data-dashboard-row="message-event"/g) ?? []).length, 2);
});

test("steering delivery evidence retains a visible protocol marker", () => {
  const snapshot = dashboardFixture();
  const delivery = snapshot.messages.filter(
    (event) => event.direction === "claude_to_codex",
  );
  assert.equal(delivery.length, 2);
  for (const event of delivery) event.steer = true;
  const model = buildDashboardViewModel(snapshot);
  assert.equal(
    model.activity.find(
      (group) => group.direction === "claude_to_codex",
    )?.steer,
    true,
  );
  assert.match(renderDashboardHtml(snapshot), />STEER<\/span>/);
});

test("72 evidence events disclose 12 omitted rows under the global budget", () => {
  const snapshot = dashboardFixture();
  snapshot.messages = Array.from(
    { length: DASHBOARD_MODEL_LIMITS.messageEvents + 12 },
    (_, index) => ({
      sequence: index + 1,
      timestamp: new Date(Date.UTC(2026, 7, 8, 11, 0, index)).toISOString(),
      messageIdSuffix: "bada55",
      direction: "claude_to_codex" as const,
      sourceAlias: "claude-advisor@this-mac",
      targetAlias: "codex-reviewer@this-mac",
      state: index === DASHBOARD_MODEL_LIMITS.messageEvents + 11
        ? ("delivered" as const)
        : ("dispatching" as const),
      bytes: 42,
    }),
  );
  const model = buildDashboardViewModel(snapshot);
  assert.equal(model.activity.length, 1);
  assert.equal(model.activity[0]?.events.length, DASHBOARD_MODEL_LIMITS.messageEvents);
  assert.equal(model.omissions.messageEvents, 12);
  assert.equal(model.omissions.messageGroups, 0);
  const html = renderDashboardHtml(snapshot);
  assert.equal(
    (html.match(/data-dashboard-row="message-event"/g) ?? []).length,
    DASHBOARD_MODEL_LIMITS.messageEvents,
  );
  assert.match(html, /12 evidence rows/);
});

test("51 active groups are counted before the 50-group display slice", () => {
  const snapshot = dashboardFixture();
  snapshot.messages = Array.from(
    { length: DASHBOARD_MODEL_LIMITS.messages + 1 },
    (_, index) => ({
      sequence: index + 1,
      timestamp: new Date(Date.UTC(2026, 7, 8, 11, index)).toISOString(),
      messageIdSuffix: index.toString(16).padStart(6, "0"),
      direction: "claude_to_codex" as const,
      sourceAlias: `claude-${String(index).padStart(2, "0")}@this-mac`,
      targetAlias: "codex-reviewer@this-mac",
      state: "queued" as const,
      bytes: 42,
    }),
  );
  snapshot.truncation.messages = 7;
  const model = buildDashboardViewModel(snapshot);
  assert.equal(model.transit.activeDeliveries, 51);
  assert.equal(model.transit.activeCountIsLowerBound, true);
  assert.equal(model.activity.length, 50);
  assert.equal(model.omissions.messageGroups, 1);
  assert.equal(model.omissions.upstreamMessageEvents, 7);
  const html = renderDashboardHtml(snapshot);
  assert.match(html, /At least 51/);
  assert.match(html, /1 delivery groups/);
  assert.match(html, /7 delivery events before dashboard projection/);
});

test("Chinese copy distinguishes static snapshots, stale routes, and expired deliveries", () => {
  const snapshot = dashboardFixture();
  snapshot.routes[1] = {
    ...snapshot.routes[1]!,
    state: "stale",
    compatibility: "expired",
  };
  snapshot.messages = [
    {
      ...snapshot.messages[0]!,
      state: "expired",
    },
  ];
  const html = renderDashboardHtml(snapshot, { locale: "zh-CN" });
  assert.equal(html.includes("即时"), false);
  assert.match(html, /一个时间点/);
  assert.match(html, /需要重新观察/);
  assert.match(html, /兼容性观察已失效/);
  assert.match(html, /已超出投递期限/);
});

test("invalid available-peer inventory is rejected as a whole", () => {
  const snapshot = dashboardFixture();
  snapshot.availablePeers = [{
    alias: "codex-impostor@this-mac",
    provider: "codex",
    host: "this-mac",
    state: "idle",
    compatibility: "compatible",
    validated: true,
    selected: false,
  }];
  const model = buildDashboardViewModel(snapshot);
  assert.deepEqual(model.peers, []);
  assert.equal(model.exchange.claude.total, 0);
  assert.equal(renderDashboardHtml(snapshot).includes("codex-impostor@this-mac"), false);
});
