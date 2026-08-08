import assert from "node:assert/strict";
import { test } from "node:test";

import {
  renderDashboardHtml,
  type DashboardSnapshot,
} from "../src/gateway/dashboard.js";

type DashboardRoute = DashboardSnapshot["routes"][number];

function counters(): DashboardRoute["counters"] {
  return {
    accepted: 0,
    delivered: 0,
    failed: 0,
    ambiguous: 0,
    expired: 0,
    cancelled: 0,
    abandoned: 0,
    rejected: 0,
    bytesAccepted: 0,
  };
}

function route(
  alias: string,
  overrides: Partial<DashboardRoute> = {},
): DashboardRoute {
  return {
    alias,
    provider: "codex",
    host: "this-mac",
    enabled: true,
    state: "busy",
    compatibility: "compatible",
    busyPolicy: "queue",
    queueDepth: 1,
    counters: counters(),
    ...overrides,
  };
}

function snapshot(routes: DashboardRoute[]): DashboardSnapshot {
  return {
    schemaVersion: 1,
    generatedAt: "2026-08-08T12:00:00.000Z",
    health: "healthy",
    connectors: [],
    availablePeers: [],
    routes,
    messages: [],
    accounting: {
      accepted: 0,
      duplicates: 0,
      delivered: 0,
      failed: 0,
      ambiguous: 0,
      expired: 0,
      cancelled: 0,
      abandoned: 0,
      rejected: 0,
      bytesAccepted: 0,
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

test("dashboard derives deterministic global and per-route queue ages at snapshot time", () => {
  const oldest = "2026-08-08T11:58:29.500Z";
  const newer = "2026-08-08T11:59:50.000Z";
  const ignoredEmptyRouteTimestamp = "2026-08-01T00:00:00.000Z";
  const input = snapshot([
    route("codex-reviewer@this-mac", {
      queueDepth: 2,
      oldestQueuedAt: oldest,
    }),
    route("claude-advisor@this-mac", {
      provider: "claude",
      queueDepth: 1,
      oldestQueuedAt: newer,
    }),
    route("codex-empty@this-mac", {
      queueDepth: 0,
      oldestQueuedAt: ignoredEmptyRouteTimestamp,
    }),
  ]);

  const first = renderDashboardHtml(input);
  const second = renderDashboardHtml(input);

  assert.equal(first, second);
  assert.match(
    first,
    /<dt>Queued messages<\/dt><dd>3<\/dd>/,
  );
  assert.match(
    first,
    new RegExp(
      `<dt>Oldest queue age</dt><dd><time datetime="${oldest}"[^>]*>1m 30s</time>`,
    ),
  );
  assert.match(
    first,
    new RegExp(
      `claude-advisor@this-mac[\\s\\S]*?1 queued[\\s\\S]*?Oldest wait <time datetime="${newer}"[^>]*>10s</time>`,
    ),
  );
  assert.match(
    first,
    new RegExp(
      `codex-reviewer@this-mac[\\s\\S]*?2 queued[\\s\\S]*?Oldest wait <time datetime="${oldest}"[^>]*>1m 30s</time>`,
    ),
  );
  assert.equal((first.match(/Oldest wait/g) ?? []).length, 2);
  assert.equal(first.includes(ignoredEmptyRouteTimestamp), false);
  assert.equal(first.includes("<script"), false);
  assert.equal(first.includes("http://"), false);
  assert.equal(first.includes("https://"), false);
});

test("queue ages floor partial seconds and cross display-unit boundaries without wall-clock reads", () => {
  const generatedAt = Date.parse("2026-08-08T12:00:00.000Z");
  const cases = [
    { elapsedMs: 999, label: "0s" },
    { elapsedMs: 59_999, label: "59s" },
    { elapsedMs: 60_000, label: "1m 0s" },
    { elapsedMs: 3_661_000, label: "1h 1m" },
    { elapsedMs: 49 * 60 * 60 * 1_000, label: "2d 1h" },
  ] as const;

  for (const { elapsedMs, label } of cases) {
    const oldestQueuedAt = new Date(generatedAt - elapsedMs).toISOString();
    const html = renderDashboardHtml(
      snapshot([
        route("codex-boundary@this-mac", { oldestQueuedAt }),
      ]),
    );
    assert.match(
      html,
      new RegExp(
        `<dt>Oldest queue age</dt><dd><time datetime="${oldestQueuedAt}"[^>]*>${label}</time>`,
      ),
      `${elapsedMs}ms global age`,
    );
    assert.match(
      html,
      new RegExp(
        `Oldest wait <time datetime="${oldestQueuedAt}"[^>]*>${label}</time>`,
      ),
      `${elapsedMs}ms route age`,
    );
  }
});

test("dashboard treats absent, malformed, future, and inconsistent queue timestamps as unavailable", () => {
  const malformed = `not-a-time"><script>QUEUE_BODY_SECRET</script>`;
  const future = "2026-08-08T12:00:00.001Z";
  const emptyTimestamp = "2026-08-08T11:00:00.000Z";
  const input = snapshot([
    route("codex-missing@this-mac"),
    route("codex-malformed@this-mac", { oldestQueuedAt: malformed }),
    route("codex-future@this-mac", { oldestQueuedAt: future }),
    route("codex-empty@this-mac", {
      queueDepth: 0,
      oldestQueuedAt: emptyTimestamp,
    }),
  ]);

  const html = renderDashboardHtml(input);

  assert.match(
    html,
    /<dt>Queued messages<\/dt><dd>3<\/dd>/,
  );
  assert.match(
    html,
    /<dt>Oldest queue age<\/dt><dd><span class="quiet" aria-label="Queue age unavailable">\u2014<\/span> <span class="metric__detail">timestamp unavailable<\/span><\/dd>/,
  );
  assert.equal((html.match(/Oldest wait/g) ?? []).length, 3);
  assert.equal(
    (html.match(/aria-label="Queue age unavailable"/g) ?? []).length,
    4,
  );
  assert.equal(html.includes("QUEUE_BODY_SECRET"), false);
  assert.equal(html.includes(future), false);
  assert.equal(html.includes(emptyTimestamp), false);
});

test("queue age uses the normalized snapshot timestamp and never Date.now", () => {
  const input = snapshot([
    route("codex-now@this-mac", {
      oldestQueuedAt: "2026-08-08T08:00:00.000-04:00",
    }),
  ]);
  const normalized = "2026-08-08T12:00:00.000Z";
  const html = renderDashboardHtml(input);

  assert.match(
    html,
    new RegExp(
      `<dt>Oldest queue age</dt><dd><time datetime="${normalized}"[^>]*>0s</time>`,
    ),
  );
  assert.match(
    html,
    new RegExp(
      `Oldest wait <time datetime="${normalized}"[^>]*>0s</time>`,
    ),
  );

  input.generatedAt = "not-a-snapshot-time";
  const invalidReference = renderDashboardHtml(input);
  assert.match(
    invalidReference,
    /<dt>Oldest queue age<\/dt><dd><span class="quiet" aria-label="Queue age unavailable">\u2014<\/span>/,
  );
  assert.equal(invalidReference.includes(normalized), false);
});

test("QUEUE_STALLED remains a normal store-provided safe alert and is never inferred by the dashboard", () => {
  const input = snapshot([
    route("codex-reviewer@this-mac", {
      oldestQueuedAt: "2026-08-08T11:50:00.000Z",
    }),
  ]);
  const withoutAlert = renderDashboardHtml(input);

  assert.equal(withoutAlert.includes("QUEUE_STALLED"), false);
  assert.match(
    withoutAlert,
    /<dt>Active alerts<\/dt><dd>0<\/dd>/,
  );

  input.alerts = [
    {
      code: "QUEUE_STALLED",
      severity: "warning",
      timestamp: "2026-08-08T11:57:30.000Z",
      provider: "codex",
      host: "this-mac",
      alias: "codex-reviewer@this-mac",
      body: "ALERT_BODY_SECRET",
      routeHandle: "NATIVE_ROUTE_UUID_SECRET",
    } as DashboardSnapshot["alerts"][number],
  ];
  const withAlert = renderDashboardHtml(input);

  assert.equal((withAlert.match(/QUEUE_STALLED/g) ?? []).length, 1);
  assert.match(withAlert, /Queued delivery is stalled/);
  assert.match(withAlert, /half of the delivery deadline/);
  assert.match(withAlert, /embassy status/);
  assert.match(withAlert, /Do not resend accepted work/);
  assert.match(
    withAlert,
    /<dt>Active alerts<\/dt><dd>1<\/dd>/,
  );
  assert.equal(withAlert.includes("ALERT_BODY_SECRET"), false);
  assert.equal(withAlert.includes("NATIVE_ROUTE_UUID_SECRET"), false);
  assert.equal(withAlert.includes("<script"), false);
});
