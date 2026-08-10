import assert from "node:assert/strict";
import { test } from "node:test";

import { renderDashboardHtml } from "../src/gateway/dashboard.js";
import {
  buildDashboardViewModel,
  DASHBOARD_MODEL_LIMITS,
} from "../src/gateway/dashboard-model.js";
import { dashboardFixture, routeCounters } from "./dashboard-fixture.js";
import {
  attachCompatibilityCertification,
  certifiedCompatibilityVersions,
  compatibilityProbeNames,
  evaluateCompatibilityAttestation,
} from "../src/gateway/compatibility.js";

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

test("diagnostics project live certification depth, time, and failure truth", () => {
  const snapshot = dashboardFixture();
  snapshot.compatibilityChecks = (["claude", "codex"] as const).map(
    (surface) =>
      attachCompatibilityCertification(
        evaluateCompatibilityAttestation({
          surface,
          version: certifiedCompatibilityVersions[surface][0]!,
          checkedAt: "2026-08-08T11:58:00.000Z",
          policy: "observed",
          certifiedVersions: certifiedCompatibilityVersions[surface],
          probes: compatibilityProbeNames[surface].map((name) => ({
            name,
            outcome: "pass" as const,
          })),
        }),
        surface === "claude"
          ? {
              depth: "wire",
              outcome: "fail",
              certifiedAt: "2026-08-08T11:59:00.000Z",
              safeErrorCode: "CLAUDE_CERTIFICATION_RECEIPT_UNCONFIRMED",
            }
          : {
              depth: "thread_ops",
              outcome: "pass",
              certifiedAt: "2026-08-08T11:59:01.000Z",
            },
      ),
  );
  const model = buildDashboardViewModel(snapshot);
  assert.deepEqual(model.compatibilityChecks[0], {
    surface: "claude",
    version: certifiedCompatibilityVersions.claude[0],
    tier: "certified",
    checkedAt: "2026-08-08T11:58:00.000Z",
    certificationDepth: "wire",
    certificationOutcome: "fail",
    certifiedAt: "2026-08-08T11:59:00.000Z",
    certificationSafeErrorCode: "CLAUDE_CERTIFICATION_RECEIPT_UNCONFIRMED",
  });
  const en = renderDashboardHtml(snapshot, { locale: "en" });
  const zh = renderDashboardHtml(snapshot, { locale: "zh-CN" });
  assert.match(en, /Live certification/);
  assert.match(en, /fail \/ wire/);
  assert.match(en, /CLAUDE_CERTIFICATION_RECEIPT_UNCONFIRMED/);
  assert.match(zh, /实时认证/);
  assert.match(zh, /pass \/ thread_ops/);
});

test("progress watches project bounded countdowns, attention, and bilingual metadata only", () => {
  const snapshot = dashboardFixture();
  snapshot.progressWatches = [
    {
      conversationIdSuffix: "AbCd_123",
      ownerAlias: "claude-advisor@this-mac",
      workerAlias: "codex-reviewer@this-mac",
      phase: "episode",
      capability: "conversation",
      lastActivityAt: "2026-08-08T11:55:00.000Z",
      nextActionAt: "2026-08-08T12:05:00.000Z",
      idleMs: 300_000,
      nudgeCount: 1,
      workerReportedComplete: true,
    },
  ];
  snapshot.progressWatchEvents = [
    {
      sequence: 7,
      timestamp: "2026-08-08T11:55:00.000Z",
      conversationIdSuffix: "AbCd_123",
      ownerAlias: "claude-advisor@this-mac",
      workerAlias: "codex-reviewer@this-mac",
      kind: "nudge",
      nudgeNumber: 1,
    },
  ];
  const model = buildDashboardViewModel(snapshot);
  assert.deepEqual(model.watches[0], {
    ...snapshot.progressWatches[0],
    idleForMs: 300_000,
    dueInMs: 300_000,
  });
  assert.equal(model.watchEvents[0]?.kind, "nudge");
  assert.equal(model.attention.some((item) => item.guidance === "progress_watch"), true);

  const en = renderDashboardHtml(snapshot, { locale: "en" });
  const zh = renderDashboardHtml(snapshot, { locale: "zh-CN" });
  assert.match(en, /Active progress watches/);
  assert.match(en, /Worker reported completion/);
  assert.match(en, /…AbCd_123/);
  assert.match(zh, /活跃进度监视/);
  assert.match(zh, /工作方已报告完成/);
  for (const secret of ["conv_", "ownerLease", "receiptHandle"]) {
    assert.equal(en.includes(secret), false);
    assert.equal(zh.includes(secret), false);
  }
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
  snapshot.alerts = [{
    code: "QUEUE_STALLED",
    severity: "warning",
    timestamp: "2026-08-08T11:57:30.000Z",
    provider: "codex",
    host: "this-mac",
    alias: "codex-reviewer@this-mac",
    body: "ALERT_BODY_SECRET",
  } as (typeof snapshot.alerts)[number]];
  const html = renderDashboardHtml(snapshot);
  assert.equal((html.match(/QUEUE_STALLED/g) ?? []).length, 1);
  assert.match(html, /Queued delivery is stalled/);
  assert.match(html, /past half of its delivery deadline/);
  assert.match(html, /Do not resend accepted work/);
  assert.equal(html.includes("ALERT_BODY_SECRET"), false);
  assert.match(html, /id="attention-title"/);
});

test("non-ready routes surface one bounded derived attention item without inventing a stall", () => {
  const snapshot = dashboardFixture();
  snapshot.routes[1] = {
    ...snapshot.routes[1]!,
    state: "stale",
    compatibility: "expired",
    safeErrorCode: "REOBSERVATION_REQUIRED",
  };
  const model = buildDashboardViewModel(snapshot);
  assert.equal(model.overall, "attention");
  assert.equal(model.attention.length, 1);
  assert.equal(model.attention[0]?.kind, "route");
  assert.equal(model.attention[0]?.guidance, "codex_stale");
  const html = renderDashboardHtml(snapshot);
  assert.match(html, /Codex route is stale/);
  assert.match(html, /Re-run register-codex with the same alias/);
  assert.match(html, /Do not unregister first/);
  assert.equal(html.includes("Unregister and register"), false);
  assert.equal(html.includes("QUEUE_STALLED"), false);
});

test("restart guidance warns about abandoning memory-only bodies", () => {
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
  assert.match(
    html,
    /Restart only when queued messages and active deliveries are both zero/,
  );
  assert.match(html, /restarting abandons memory-only message bodies/);
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
  assert.match(noPeers, /No ready consent edge exists/);
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
    unpairedReadyClaude: 1,
    unpairedReadyCodex: 0,
  });
  assert.equal(model.omissions.pairs, 2);
  const html = renderDashboardHtml(snapshot);
  assert.match(html, /claude-advisor@this-mac paired with codex-reviewer@this-mac/);
  assert.match(html, /claude-reviewer@this-mac paired with codex-builder@this-mac/);
  assert.match(html, /2 additional consent edges are omitted/);
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
