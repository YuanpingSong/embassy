import assert from "node:assert/strict";
import {
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { test } from "node:test";
import { Script } from "node:vm";

import { getDashboardCopy } from "../src/gateway/dashboard-copy.js";
import { renderLiveDashboardAssets } from "../src/gateway/live-dashboard-assets.js";
import {
  LIVE_DASHBOARD_LIMITS,
  liveDashboardSecurityHeaders,
  validateLiveDashboardRequest,
} from "../src/gateway/live-dashboard-protocol.js";
import {
  createLiveDashboardStreamHub,
  type LiveDashboardClock,
  type LiveDashboardObservation,
  type LiveDashboardStreamWriter,
} from "../src/gateway/live-dashboard-stream.js";
import {
  bindLiveDashboardServer,
  type LiveDashboardHttpFactory,
  type LiveDashboardHttpServer,
} from "../src/gateway/live-dashboard-server.js";
import {
  isLiveDashboardStartupCancelled,
  startLiveDashboard,
} from "../src/gateway/live-dashboard.js";
import { dashboardFixture } from "./dashboard-fixture.js";

const NOOP_ACTIONS = Object.freeze({
  execute: async () => ({ ok: true, code: "ok" as const }),
});

const TEST_LIVE_DASHBOARD_PORT = 41_961;
const TEST_LIVE_DASHBOARD_URL = `http://127.0.0.1:${TEST_LIVE_DASHBOARD_PORT}/`;

type HttpSmokeResponse = Readonly<{
  statusCode: number;
  headers: IncomingHttpHeaders;
  body: string;
}>;

function requestHttpSmoke(
  url: URL,
  options: Readonly<{
    method?: "GET" | "POST";
    headers?: Readonly<Record<string, string>>;
    body?: string;
  }> = {},
): Promise<HttpSmokeResponse> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      url,
      {
        method: options.method ?? "GET",
        headers: options.headers,
        signal: AbortSignal.timeout(5_000),
      },
      (response) => {
        response.setEncoding("utf8");
        let body = "";
        response.on("data", (chunk: string) => {
          body += chunk;
        });
        response.once("end", () => {
          resolve({
            statusCode: response.statusCode ?? 0,
            headers: response.headers,
            body,
          });
        });
        response.once("error", reject);
      },
    );
    request.once("error", reject);
    request.end(options.body);
  });
}

function openHttpSmokeStream(
  url: URL,
  headers: Readonly<Record<string, string>>,
): Promise<Readonly<{
  response: IncomingMessage;
  firstFrame: string;
  ended: Promise<void>;
}>> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      url,
      {
        method: "POST",
        headers,
        signal: AbortSignal.timeout(5_000),
      },
      (response) => {
        response.setEncoding("utf8");
        let buffer = "";
        let resolved = false;
        const ended = new Promise<void>((resolveEnd, rejectEnd) => {
          response.once("end", resolveEnd);
          response.once("error", rejectEnd);
        });
        response.on("data", (chunk: string) => {
          buffer += chunk.replaceAll("\r\n", "\n");
          const boundary = buffer.indexOf("\n\n");
          if (!resolved && boundary >= 0) {
            resolved = true;
            resolve({
              response,
              firstFrame: buffer.slice(0, boundary + 2),
              ended,
            });
          }
        });
        response.once("end", () => {
          if (!resolved) reject(new Error("LIVE_SMOKE_STREAM_ENDED_EARLY"));
        });
        response.once("error", reject);
      },
    );
    request.once("error", reject);
    request.end();
  });
}

function validRequest(
  overrides: Partial<{
    method: string;
    target: string;
    rawHeaders: string[];
  }> = {},
) {
  return {
    method: overrides.method ?? "POST",
    target: overrides.target ?? "/snapshot",
    rawHeaders:
      overrides.rawHeaders ??
      [
        "Host",
        `127.0.0.1:${TEST_LIVE_DASHBOARD_PORT}`,
        "Origin",
        `http://127.0.0.1:${TEST_LIVE_DASHBOARD_PORT}`,
        "X-Embassy-Request",
        "1",
      ],
  };
}

test("live request validation rejects proxy forms, alternate origins, and duplicate sensitive headers", () => {
  const expected = {
    expectedHost: `127.0.0.1:${TEST_LIVE_DASHBOARD_PORT}`,
    expectedOrigin: `http://127.0.0.1:${TEST_LIVE_DASHBOARD_PORT}`,
    kind: "api" as const,
  };
  assert.equal(validateLiveDashboardRequest(validRequest(), expected).ok, true);
  for (const request of [
    validRequest({
      target: `http://127.0.0.1:${TEST_LIVE_DASHBOARD_PORT}/snapshot`,
    }),
    validRequest({
      target: `//127.0.0.1:${TEST_LIVE_DASHBOARD_PORT}/snapshot`,
    }),
    validRequest({ method: "OPTIONS" }),
    validRequest({
      rawHeaders: [
        "Host",
        `127.0.0.1:${TEST_LIVE_DASHBOARD_PORT}`,
        "Host",
        "attacker.invalid",
        "Origin",
        `http://127.0.0.1:${TEST_LIVE_DASHBOARD_PORT}`,
        "X-Embassy-Request",
        "1",
      ],
    }),
    validRequest({
      rawHeaders: [
        "Host",
        `127.0.0.1:${TEST_LIVE_DASHBOARD_PORT}`,
        "Origin",
        "http://attacker.invalid",
        "X-Embassy-Request",
        "1",
      ],
    }),
    validRequest({
      rawHeaders: [
        "Host",
        `127.0.0.1:${TEST_LIVE_DASHBOARD_PORT}`,
        "Origin",
        `http://127.0.0.1:${TEST_LIVE_DASHBOARD_PORT}`,
        "X-Embassy-Request",
        "1",
        "Forwarded",
        "host=127.0.0.1",
      ],
    }),
    validRequest({
      rawHeaders: [
        "Host",
        `127.0.0.1:${TEST_LIVE_DASHBOARD_PORT}`,
        "Origin",
        `http://127.0.0.1:${TEST_LIVE_DASHBOARD_PORT}`,
        "X-Embassy-Request",
        "1",
        "Transfer-Encoding",
        "chunked",
      ],
    }),
  ]) {
    assert.equal(validateLiveDashboardRequest(request, expected).ok, false);
  }
});

test("navigation permits an absent Origin but API reads require the exact origin and sentinel", () => {
  const navigation = validateLiveDashboardRequest(
    {
      method: "GET",
      target: "/",
      rawHeaders: ["Host", `127.0.0.1:${TEST_LIVE_DASHBOARD_PORT}`],
    },
    {
      expectedHost: `127.0.0.1:${TEST_LIVE_DASHBOARD_PORT}`,
      expectedOrigin: `http://127.0.0.1:${TEST_LIVE_DASHBOARD_PORT}`,
      kind: "navigation",
    },
  );
  assert.equal(navigation.ok, true);
  const missingSentinel = validRequest({
    rawHeaders: [
      "Host",
      `127.0.0.1:${TEST_LIVE_DASHBOARD_PORT}`,
      "Origin",
      `http://127.0.0.1:${TEST_LIVE_DASHBOARD_PORT}`,
    ],
  });
  assert.deepEqual(
    validateLiveDashboardRequest(missingSentinel, {
      expectedHost: `127.0.0.1:${TEST_LIVE_DASHBOARD_PORT}`,
      expectedOrigin: `http://127.0.0.1:${TEST_LIVE_DASHBOARD_PORT}`,
      kind: "api",
    }),
    {
      ok: false,
      statusCode: 403,
      safeCode: "CROSS_ORIGIN_REQUEST",
    },
  );
});

test("response helpers remain local, non-cacheable, and credential-free", () => {
  const headers = liveDashboardSecurityHeaders();
  assert.equal(headers["Cache-Control"], "no-store");
  assert.equal("Access-Control-Allow-Origin" in headers, false);
  assert.equal("Set-Cookie" in headers, false);
  assert.match(headers["Content-Security-Policy"] ?? "", /default-src 'none'/u);
});

type FakeClock = LiveDashboardClock & {
  advance(milliseconds: number): void;
  fire(): void;
  intervalCount(): number;
};

function fakeClock(): FakeClock {
  let now = 10_000;
  const callbacks = new Set<() => void>();
  return {
    now: () => now,
    setInterval: (callback) => {
      callbacks.add(callback);
      return callback;
    },
    clearInterval: (handle) => {
      callbacks.delete(handle as () => void);
    },
    advance: (milliseconds) => {
      now += milliseconds;
    },
    fire: () => {
      for (const callback of [...callbacks]) callback();
    },
    intervalCount: () => callbacks.size,
  };
}

type FakeWriter = LiveDashboardStreamWriter & {
  frames: string[];
  ended: boolean;
  drain(): void;
  disconnect(): void;
};

function fakeWriter(writeResults: boolean[] = []): FakeWriter {
  const frames: string[] = [];
  let drainCallback: () => void = () => {};
  let closeCallback: () => void = () => {};
  let ended = false;
  return {
    frames,
    get ended() {
      return ended;
    },
    write: (chunk) => {
      frames.push(chunk);
      return writeResults.shift() ?? true;
    },
    onDrain: (callback) => {
      drainCallback = callback;
    },
    onClose: (callback) => {
      closeCallback = callback;
    },
    end: () => {
      ended = true;
    },
    drain: () => drainCallback(),
    disconnect: () => closeCallback(),
  };
}

test("one central poller starts only with clients and fingerprints same-revision changes", async () => {
  const clock = fakeClock();
  const first = dashboardFixture();
  const second = dashboardFixture();
  second.health = "degraded";
  const observations: LiveDashboardObservation[] = [
    { snapshotRevision: 7, snapshot: first },
    { snapshotRevision: 7, snapshot: second },
  ];
  let calls = 0;
  const hub = createLiveDashboardStreamHub({
    clock,
    observer: {
      observe: async () => observations[Math.min(calls++, observations.length - 1)]!,
    },
  });
  assert.equal(clock.intervalCount(), 0);
  assert.equal(calls, 0);
  const writer = fakeWriter();
  assert.equal(hub.add(writer).ok, true);
  assert.equal(clock.intervalCount(), 1);
  await hub.pollNow();
  assert.equal(calls, 1);
  assert.match(writer.frames.at(-1) ?? "", /"streamRevision":1/u);
  await hub.pollNow();
  assert.equal(calls, 2);
  assert.match(writer.frames.at(-1) ?? "", /"streamRevision":2/u);
  assert.match(writer.frames.at(-1) ?? "", /"reset":false/u);
  writer.disconnect();
  assert.equal(clock.intervalCount(), 0);
  assert.equal(hub.streamCount(), 0);
});

test("clock-derived field churn never publishes and never signals a reset", async () => {
  const clock = fakeClock();
  const first = dashboardFixture();
  const second = dashboardFixture();
  second.generatedAt = "2026-08-08T12:00:02.000Z";
  for (const route of second.routes) {
    route.lastSeenAt = "2026-08-08T12:00:01.000Z";
  }
  const observations: LiveDashboardObservation[] = [
    { snapshotRevision: 7, snapshot: first },
    { snapshotRevision: 7, snapshot: second },
  ];
  let calls = 0;
  const hub = createLiveDashboardStreamHub({
    clock,
    observer: {
      observe: async () =>
        observations[Math.min(calls++, observations.length - 1)]!,
    },
  });
  const writer = fakeWriter();
  assert.equal(hub.add(writer).ok, true);
  await hub.pollNow();
  const framesAfterFirst = writer.frames.length;
  await hub.pollNow();
  assert.equal(calls, 2);
  assert.equal(writer.frames.length, framesAfterFirst);
  assert.equal(hub.latest()?.streamRevision, 1);
  assert.equal(hub.latest()?.reset, false);
  writer.disconnect();
});

test("a source revision regression is the reset signal", async () => {
  const clock = fakeClock();
  const fixture = dashboardFixture();
  const observations: LiveDashboardObservation[] = [
    { snapshotRevision: 7, snapshot: fixture },
    { snapshotRevision: 3, snapshot: fixture },
  ];
  let calls = 0;
  const hub = createLiveDashboardStreamHub({
    clock,
    observer: {
      observe: async () =>
        observations[Math.min(calls++, observations.length - 1)]!,
    },
  });
  const writer = fakeWriter();
  assert.equal(hub.add(writer).ok, true);
  await hub.pollNow();
  await hub.pollNow();
  assert.equal(calls, 2);
  assert.match(writer.frames.at(-1) ?? "", /"streamRevision":2/u);
  assert.match(writer.frames.at(-1) ?? "", /"reset":true/u);
  writer.disconnect();
});

test("manual refresh observes a fresh snapshot with no live stream", async () => {
  const clock = fakeClock();
  const first = dashboardFixture();
  const second = dashboardFixture();
  second.health = "degraded";
  const observations: LiveDashboardObservation[] = [
    { snapshotRevision: 1, snapshot: first },
    { snapshotRevision: 2, snapshot: second },
  ];
  let calls = 0;
  const hub = createLiveDashboardStreamHub({
    clock,
    observer: {
      observe: async () => observations[Math.min(calls++, observations.length - 1)]!,
    },
  });
  await hub.pollNow();
  assert.equal(calls, 0);
  const initial = await hub.refresh();
  assert.equal(calls, 1);
  assert.equal(initial?.snapshotRevision, 1);
  const refreshed = await hub.refresh();
  assert.equal(calls, 2);
  assert.equal(refreshed?.snapshotRevision, 2);
  assert.equal(refreshed?.model.health, "degraded");
  assert.equal(clock.intervalCount(), 0);
});

test("stream hub enforces four clients, latest-wins backpressure, and bounded shutdown", async () => {
  const clock = fakeClock();
  let revision = 0;
  const hub = createLiveDashboardStreamHub({
    clock,
    observer: {
      observe: async () => {
        const snapshot = dashboardFixture();
        snapshot.health = revision % 2 === 0 ? "healthy" : "degraded";
        return { snapshotRevision: revision++, snapshot };
      },
    },
  });
  const blocked = fakeWriter([false, true]);
  const others = Array.from({ length: 3 }, () => fakeWriter());
  assert.equal(hub.add(blocked).ok, true);
  for (const writer of others) assert.equal(hub.add(writer).ok, true);
  assert.deepEqual(hub.add(fakeWriter()), {
    ok: false,
    safeCode: "LIVE_STREAM_LIMIT",
  });
  await hub.pollNow();
  await hub.pollNow();
  await hub.pollNow();
  assert.equal(blocked.frames.length, 1);
  blocked.drain();
  assert.equal(blocked.frames.length, 2);
  assert.match(blocked.frames[1] ?? "", /"snapshotRevision":2/u);

  const lagging = others[0]!;
  clock.advance(LIVE_DASHBOARD_LIMITS.heartbeatIntervalMs);
  clock.fire();
  await Promise.resolve();
  assert.equal(lagging.frames.some((frame) => frame.startsWith(": heartbeat ")), true);
  hub.shutdown();
  assert.equal(clock.intervalCount(), 0);
  assert.equal(hub.streamCount(), 0);
  assert.equal(blocked.ended, true);
  assert.equal(others.every((writer) => writer.ended), true);
  assert.match(
    others[1]!.frames.at(-1) ?? "",
    /event: shutdown\ndata: \{"safeCode":"LIVE_DASHBOARD_SHUTDOWN"\}/u,
  );
});

test("blocked streams are disconnected after five seconds", async () => {
  const clock = fakeClock();
  const writer = fakeWriter([false]);
  const hub = createLiveDashboardStreamHub({
    clock,
    observer: {
      observe: async () => ({ snapshotRevision: 1, snapshot: dashboardFixture() }),
    },
  });
  hub.add(writer);
  await hub.pollNow();
  clock.advance(LIVE_DASHBOARD_LIMITS.backpressureTimeoutMs);
  clock.fire();
  assert.equal(writer.ended, true);
  assert.equal(hub.streamCount(), 0);
});

test("browser assets use the shared bilingual catalog and inert React bootstrap", () => {
  for (const locale of ["en", "zh-CN"] as const) {
    const assets = renderLiveDashboardAssets(locale);
    const copy = getDashboardCopy(locale);
    assert.match(assets.shellHtml, new RegExp(`<html lang="${locale}"`, "u"));
    assert.equal(assets.shellHtml.includes(`<title>${copy["live.title"]}</title>`), true);
    assert.equal(assets.shellHtml.includes(`<noscript>${copy["live.noscript"]}</noscript>`), true);
    assert.equal(
      assets.clientJavaScript.includes(JSON.stringify(copy["live.mastheadSubtitle"])),
      true,
    );
    assert.equal(
      assets.clientJavaScript.includes(JSON.stringify(copy["live.readonlyFooter"])),
      true,
    );
    assert.doesNotMatch(assets.shellHtml, /hreflang/u);
    assert.match(assets.clientJavaScript, /window\.EMBASSY_BOOT/u);
    assert.match(assets.clientJavaScript, /zh-CN/u);
    assert.doesNotMatch(assets.clientJavaScript, /const LIVE=/u);
    assert.doesNotThrow(() => new Script(assets.clientJavaScript));
    assert.doesNotMatch(
      assets.clientJavaScript,
      /innerHTML|eval\(|localStorage|sessionStorage|document\.cookie|serviceWorker/u,
    );
    assert.doesNotThrow(() => new Script(assets.appJavaScript));
    assert.match(assets.appJavaScript, /ReactDOM\.createRoot/u);
    assert.match(assets.shellHtml, /<div id="root"/u);
    assert.equal(assets.shellHtml.includes('<script defer src="client.js"></script>'), true);
    assert.equal(assets.shellHtml.includes('<script defer src="app.js"></script>'), true);
  }
  assert.throws(
    () => renderLiveDashboardAssets("zh-cn" as "zh-CN"),
    /DASHBOARD_LOCALE_UNSUPPORTED/u,
  );
});

type FakeHttpHarness = Readonly<{
  factory: LiveDashboardHttpFactory;
  dispatch(request: IncomingMessage, response: ServerResponse): void;
  server: LiveDashboardHttpServer & {
    closed: boolean;
    closeCalls: number;
    forceCloseCalls: number;
    listenOptions?: Readonly<{
      host: "127.0.0.1";
      port: number;
      exclusive: true;
    }>;
  };
}>;

function fakeHttpHarness(
  address: Readonly<{
    address: string;
    family: string;
    port: number;
  }> = {
    address: "127.0.0.1",
    family: "IPv4",
    port: TEST_LIVE_DASHBOARD_PORT,
  },
  behavior: Readonly<{
    blockedConnection?: boolean;
    listenError?: Error;
  }> = {},
): FakeHttpHarness {
  const callbacks = new Map<string, Set<(...arguments_: never[]) => void>>();
  let requestListener:
    | ((request: IncomingMessage, response: ServerResponse) => void)
    | undefined;
  let pendingClose: ((error?: Error) => void) | undefined;
  const serverObject = {
    maxConnections: 0,
    headersTimeout: 0,
    requestTimeout: 0,
    keepAliveTimeout: 0,
    closed: false,
    closeCalls: 0,
    forceCloseCalls: 0,
    listenOptions: undefined as
      | Readonly<{
          host: "127.0.0.1";
          port: number;
          exclusive: true;
        }>
      | undefined,
    listen(
      options: Readonly<{
        host: "127.0.0.1";
        port: number;
        exclusive: true;
      }>,
    ) {
      this.listenOptions = options;
      if (behavior.listenError !== undefined) throw behavior.listenError;
      queueMicrotask(() => {
        const listeners = [...(callbacks.get("listening") ?? [])];
        callbacks.delete("listening");
        for (const listener of listeners) listener();
      });
    },
    address: () => address,
    once(event: string, callback: (...arguments_: never[]) => void) {
      const listeners = callbacks.get(event) ?? new Set();
      listeners.add(callback);
      callbacks.set(event, listeners);
    },
    off(event: string, callback: (...arguments_: never[]) => void) {
      callbacks.get(event)?.delete(callback);
    },
    close(callback: (error?: Error) => void) {
      this.closed = true;
      this.closeCalls += 1;
      if (behavior.blockedConnection === true) {
        pendingClose = callback;
        return;
      }
      callback();
    },
    closeAllConnections() {
      this.forceCloseCalls += 1;
      const callback = pendingClose;
      pendingClose = undefined;
      if (callback !== undefined) queueMicrotask(callback);
    },
  };
  const server = serverObject as unknown as FakeHttpHarness["server"];
  return {
    server,
    dispatch: (request, response) => {
      assert.ok(requestListener);
      requestListener(request, response);
    },
    factory: {
      createServer: (listener) => {
        requestListener = listener;
        return server;
      },
    },
  };
}

test("top-level start binds the exact requested loopback port and opens its root URL", async () => {
  const harness = fakeHttpHarness();
  let observerCalls = 0;
  let openedUrl: string | undefined;
  const running = await startLiveDashboard({
    port: TEST_LIVE_DASHBOARD_PORT,
    actions: NOOP_ACTIONS,
    locale: "zh-CN",
    observer: {
      observe: async () => {
        observerCalls += 1;
        return { snapshotRevision: 0, snapshot: dashboardFixture() };
      },
    },
    dependencies: {
      http: harness.factory,
      openDashboard: (url) => {
        openedUrl = url;
      },
    },
  });
  assert.deepEqual(running.address, {
    host: "127.0.0.1",
    port: TEST_LIVE_DASHBOARD_PORT,
  });
  assert.equal(running.url, TEST_LIVE_DASHBOARD_URL);
  assert.equal(openedUrl, TEST_LIVE_DASHBOARD_URL);
  assert.equal(observerCalls, 0);
  assert.deepEqual(harness.server.listenOptions, {
    host: "127.0.0.1",
    port: TEST_LIVE_DASHBOARD_PORT,
    exclusive: true,
  });
  assert.equal(
    harness.server.maxConnections,
    LIVE_DASHBOARD_LIMITS.maximumConnections,
  );
  assert.equal(
    harness.server.headersTimeout,
    LIVE_DASHBOARD_LIMITS.headersTimeoutMs,
  );
  await running.close();
  assert.equal(harness.server.closed, true);
  await running.close();
  assert.equal(harness.server.closeCalls, 1);
});

test("shutdown force-closes a blocked connection exactly once", async () => {
  const harness = fakeHttpHarness(
    {
      address: "127.0.0.1",
      family: "IPv4",
      port: TEST_LIVE_DASHBOARD_PORT,
    },
    { blockedConnection: true },
  );
  const running = await startLiveDashboard({
    port: TEST_LIVE_DASHBOARD_PORT,
    actions: NOOP_ACTIONS,
    observer: {
      observe: async () => ({
        snapshotRevision: 0,
        snapshot: dashboardFixture(),
      }),
    },
    dependencies: { http: harness.factory },
  });
  const closing = Promise.all([running.close(), running.close()]);
  let hangTimer: NodeJS.Timeout | undefined;
  const outcome = await Promise.race([
    closing.then(() => "closed" as const),
    new Promise<"hung">((resolve) => {
      hangTimer = setTimeout(() => resolve("hung"), 250);
    }),
  ]);
  if (hangTimer !== undefined) clearTimeout(hangTimer);
  assert.equal(outcome, "closed");
  assert.equal(harness.server.closeCalls, 1);
  assert.equal(harness.server.forceCloseCalls, 1);
});

test("real loopback composition serves multiple windows directly and closes cleanly", async () => {
  let observerCalls = 0;
  let openedUrl: string | undefined;
  let running: Awaited<ReturnType<typeof startLiveDashboard>> | undefined;
  try {
    running = await startLiveDashboard({
      // A real-listener test must never claim the production stable port.
      port: 0,
      actions: NOOP_ACTIONS,
      observer: {
        observe: async () => {
          observerCalls += 1;
          return { snapshotRevision: 1, snapshot: dashboardFixture() };
        },
      },
      dependencies: {
        openDashboard: (url) => {
          openedUrl = url;
        },
      },
    });
    assert.equal(running.address.host, "127.0.0.1");
    assert.equal(running.address.port > 0, true);
    assert.equal(
      running.url,
      `http://127.0.0.1:${running.address.port}/`,
    );
    assert.equal(openedUrl, running.url);
    const dashboardUrl = new URL(running.url);
    const [firstWindow, secondWindow] = await Promise.all([
      requestHttpSmoke(dashboardUrl),
      requestHttpSmoke(dashboardUrl),
    ]);
    for (const shell of [firstWindow, secondWindow]) {
      assert.equal(shell.statusCode, 200);
      assert.match(shell.body, /id="root"/u);
      assert.equal(shell.headers["cache-control"], "no-store");
      assert.equal(shell.headers["set-cookie"], undefined);
    }

    const snapshotUrl = new URL("snapshot", dashboardUrl);
    const rejectedSnapshot = await requestHttpSmoke(snapshotUrl, {
      method: "POST",
      headers: { "Content-Length": "0" },
    });
    assert.equal(rejectedSnapshot.statusCode, 403);

    const apiHeaders = {
      Origin: dashboardUrl.origin,
      "X-Embassy-Request": "1",
      "Content-Length": "0",
    };
    const snapshots = await Promise.all([
      requestHttpSmoke(snapshotUrl, { method: "POST", headers: apiHeaders }),
      requestHttpSmoke(snapshotUrl, { method: "POST", headers: apiHeaders }),
    ]);
    assert.equal(snapshots.every(({ statusCode }) => statusCode === 200), true);
    assert.equal(
      snapshots.every(({ headers }) => headers["set-cookie"] === undefined),
      true,
    );

    const streamUrl = new URL("stream", dashboardUrl);
    const stream = await openHttpSmokeStream(streamUrl, apiHeaders);
    assert.equal(stream.response.statusCode, 200);
    assert.match(stream.firstFrame, /^id: 1\nevent: snapshot\ndata: /u);
    assert.match(stream.firstFrame, /"snapshotRevision":1/u);
    assert.equal(observerCalls, 3);

    await running.close();
    await stream.ended;
    running = undefined;
    await assert.rejects(requestHttpSmoke(dashboardUrl));
  } finally {
    await running?.close().catch(() => undefined);
  }
});

test("a pre-aborted start creates no server, browser, or observation side effect", async () => {
  const harness = fakeHttpHarness();
  const controller = new AbortController();
  controller.abort();
  let serverCreations = 0;
  let openCalls = 0;
  let observerCalls = 0;
  await assert.rejects(
    startLiveDashboard({
      port: TEST_LIVE_DASHBOARD_PORT,
      actions: NOOP_ACTIONS,
      signal: controller.signal,
      observer: {
        observe: async () => {
          observerCalls += 1;
          return { snapshotRevision: 0, snapshot: dashboardFixture() };
        },
      },
      dependencies: {
        http: {
          createServer: (listener) => {
            serverCreations += 1;
            return harness.factory.createServer(listener);
          },
        },
        openDashboard: () => {
          openCalls += 1;
        },
      },
    }),
    isLiveDashboardStartupCancelled,
  );
  assert.equal(serverCreations, 0);
  assert.equal(openCalls, 0);
  assert.equal(observerCalls, 0);
});

test("abort during a hung browser open closes the listener and cancels startup", async () => {
  const harness = fakeHttpHarness();
  const controller = new AbortController();
  let openerCalls = 0;
  let observerCalls = 0;
  let releaseOpen = (): void => {};
  let markOpenStarted = (): void => {};
  const openGate = new Promise<void>((resolve) => {
    releaseOpen = resolve;
  });
  const openStarted = new Promise<void>((resolve) => {
    markOpenStarted = resolve;
  });
  try {
    const starting = startLiveDashboard({
      port: TEST_LIVE_DASHBOARD_PORT,
      actions: NOOP_ACTIONS,
      locale: "zh-CN",
      signal: controller.signal,
      observer: {
        observe: async () => {
          observerCalls += 1;
          return { snapshotRevision: 0, snapshot: dashboardFixture() };
        },
      },
      dependencies: {
        http: harness.factory,
        openDashboard: async (url) => {
          openerCalls += 1;
          assert.equal(url, TEST_LIVE_DASHBOARD_URL);
          markOpenStarted();
          await openGate;
        },
      },
    });
    await openStarted;
    assert.equal(harness.server.closed, false);
    const rootResponse = {
      headersSent: false,
      writableEnded: false,
      statusCode: 0,
      headers: {} as Record<string, string>,
      body: "",
      writeHead(statusCode: number, headers: Record<string, string>) {
        this.statusCode = statusCode;
        this.headers = { ...headers };
        this.headersSent = true;
        return this;
      },
      end(chunk?: string | Buffer) {
        if (chunk !== undefined) {
          this.body += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
        }
        this.writableEnded = true;
        return this;
      },
    };
    harness.dispatch(
      {
        method: "GET",
        url: "/",
        rawHeaders: ["Host", `127.0.0.1:${TEST_LIVE_DASHBOARD_PORT}`],
      } as IncomingMessage,
      rootResponse as unknown as ServerResponse,
    );
    assert.equal(rootResponse.statusCode, 200);
    assert.match(rootResponse.body, /<html lang="zh-CN"/u);
    assert.match(rootResponse.body, /id="root"/u);
    controller.abort();
    const outcome = await Promise.race([
      starting.then(
        () => "ready" as const,
        (error: unknown) =>
          isLiveDashboardStartupCancelled(error)
            ? ("cancelled" as const)
            : ("failed" as const),
      ),
      new Promise<"hung">((resolve) => setImmediate(() => resolve("hung"))),
    ]);
    assert.equal(outcome, "cancelled");
    assert.equal(harness.server.closed, true);
    assert.equal(openerCalls, 1);
    assert.equal(observerCalls, 0);
  } finally {
    releaseOpen();
  }
});

test("invalid requested ports are rejected before listen", async () => {
  for (const port of [-1, 65_536, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    const harness = fakeHttpHarness();
    await assert.rejects(
      bindLiveDashboardServer(harness.server, port),
      /LIVE_DASHBOARD_PORT_INVALID/u,
    );
    assert.equal(harness.server.listenOptions, undefined);
    assert.equal(harness.server.closed, false);
  }
});

test("an occupied requested port is surfaced as an actionable bind rejection", async () => {
  const addressInUse = Object.assign(new Error("listen EADDRINUSE"), {
    code: "EADDRINUSE",
  });
  const harness = fakeHttpHarness(
    undefined,
    { listenError: addressInUse },
  );
  await assert.rejects(
    bindLiveDashboardServer(harness.server, TEST_LIVE_DASHBOARD_PORT),
    (error: unknown) =>
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "LIVE_DASHBOARD_PORT_IN_USE" &&
      error instanceof Error &&
      new RegExp(
        `port ${TEST_LIVE_DASHBOARD_PORT}.*--port <n>`,
        "u",
      ).test(error.message),
  );
  assert.equal(harness.server.closed, false);
});

test("post-bind verification rejects non-loopback and wrong-port bindings", async () => {
  for (const address of [
    { address: "::1", family: "IPv6", port: TEST_LIVE_DASHBOARD_PORT },
    {
      address: "0.0.0.0",
      family: "IPv4",
      port: TEST_LIVE_DASHBOARD_PORT,
    },
    { address: "127.0.0.1", family: "IPv4", port: 0 },
    {
      address: "127.0.0.1",
      family: "IPv4",
      port: TEST_LIVE_DASHBOARD_PORT + 1,
    },
  ]) {
    const harness = fakeHttpHarness(address);
    await assert.rejects(
      bindLiveDashboardServer(harness.server, TEST_LIVE_DASHBOARD_PORT),
      /LIVE_DASHBOARD_BIND_NOT_IPV4_LOOPBACK/u,
    );
    assert.equal(harness.server.closed, true);
  }
});
