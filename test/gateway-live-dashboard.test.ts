import assert from "node:assert/strict";
import { chmod, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import {
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Script } from "node:vm";

import { getDashboardCopy } from "../src/gateway/dashboard-copy.js";
import { renderLiveDashboardAssets } from "../src/gateway/live-dashboard-assets.js";
import {
  createLiveDashboardBootstrap,
  defaultLiveDashboardFileSystem,
  type LiveDashboardFileSystem,
} from "../src/gateway/live-dashboard-bootstrap.js";
import {
  LIVE_DASHBOARD_LIMITS,
  liveDashboardSecurityHeaders,
  readSingleCookie,
  sessionCookieHeader,
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
    target: overrides.target ?? "/instance/snapshot",
    rawHeaders:
      overrides.rawHeaders ??
      [
        "Host",
        "127.0.0.1:48123",
        "Origin",
        "http://127.0.0.1:48123",
        "X-Embassy-Request",
        "1",
      ],
  };
}

test("live request validation rejects proxy forms, alternate origins, and duplicate sensitive headers", () => {
  const expected = {
    expectedHost: "127.0.0.1:48123",
    expectedOrigin: "http://127.0.0.1:48123",
    kind: "authenticated" as const,
  };
  assert.equal(validateLiveDashboardRequest(validRequest(), expected).ok, true);
  for (const request of [
    validRequest({ target: "http://127.0.0.1:48123/instance/snapshot" }),
    validRequest({ target: "//127.0.0.1:48123/instance/snapshot" }),
    validRequest({ method: "OPTIONS" }),
    validRequest({
      rawHeaders: [
        "Host",
        "127.0.0.1:48123",
        "Host",
        "attacker.invalid",
        "Origin",
        "http://127.0.0.1:48123",
        "X-Embassy-Request",
        "1",
      ],
    }),
    validRequest({
      rawHeaders: [
        "Host",
        "127.0.0.1:48123",
        "Origin",
        "http://attacker.invalid",
        "X-Embassy-Request",
        "1",
      ],
    }),
    validRequest({
      rawHeaders: [
        "Host",
        "127.0.0.1:48123",
        "Origin",
        "http://127.0.0.1:48123",
        "X-Embassy-Request",
        "1",
        "Forwarded",
        "host=127.0.0.1",
      ],
    }),
    validRequest({
      rawHeaders: [
        "Host",
        "127.0.0.1:48123",
        "Origin",
        "http://127.0.0.1:48123",
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

test("navigation permits an absent Origin but authenticated reads require the exact origin and sentinel", () => {
  const navigation = validateLiveDashboardRequest(
    {
      method: "GET",
      target: "/instance/bootstrap",
      rawHeaders: ["Host", "127.0.0.1:48123"],
    },
    {
      expectedHost: "127.0.0.1:48123",
      expectedOrigin: "http://127.0.0.1:48123",
      kind: "navigation",
    },
  );
  assert.equal(navigation.ok, true);
  const missingSentinel = validRequest({
    rawHeaders: [
      "Host",
      "127.0.0.1:48123",
      "Origin",
      "http://127.0.0.1:48123",
    ],
  });
  assert.deepEqual(
    validateLiveDashboardRequest(missingSentinel, {
      expectedHost: "127.0.0.1:48123",
      expectedOrigin: "http://127.0.0.1:48123",
      kind: "authenticated",
    }),
    {
      ok: false,
      statusCode: 403,
      safeCode: "CROSS_ORIGIN_REQUEST",
    },
  );
});

test("cookie and response helpers keep the session path-scoped and non-persistent", () => {
  const cookie = sessionCookieHeader(
    "embassy_live",
    "a".repeat(43),
    "/abcdefghijklmnopqrstuv",
  );
  assert.equal(
    cookie,
    `embassy_live=${"a".repeat(43)}; Path=/abcdefghijklmnopqrstuv/; HttpOnly; SameSite=Strict`,
  );
  assert.doesNotMatch(cookie, /Domain|Expires|Max-Age|Secure/u);
  assert.equal(
    readSingleCookie(`other=x; embassy_live=${"a".repeat(43)}`, "embassy_live"),
    "a".repeat(43),
  );
  assert.equal(
    readSingleCookie(
      `embassy_live=${"a".repeat(43)}; embassy_live=${"b".repeat(43)}`,
      "embassy_live",
    ),
    undefined,
  );
  const headers = liveDashboardSecurityHeaders();
  assert.equal(headers["Cache-Control"], "no-store");
  assert.equal("Access-Control-Allow-Origin" in headers, false);
  assert.match(headers["Content-Security-Policy"] ?? "", /default-src 'none'/u);
});

test("private bootstrap uses a fragment capability and exact-owned cleanup", async () => {
  const temporary = path.join(
    os.tmpdir(),
    `embassy-live-test-${process.pid}-${Date.now()}`,
  );
  await mkdir(temporary, { mode: 0o700 });
  await chmod(temporary, 0o700);
  try {
    let call = 0;
    const artifacts = await createLiveDashboardBootstrap({
      privateStateRoot: temporary,
      bootstrapTargetWithoutFragment:
        "http://127.0.0.1:48123/abcdefghijklmnopqrstuv/bootstrap",
      lang: "zh-CN",
      random: (size) => new Uint8Array(size).fill(++call),
    });
    const document = await readFile(artifacts.bootstrapPath, "utf8");
    assert.match(document, /^<!doctype html>\n<html lang="zh-CN">/u);
    assert.match(document, /<title>打开 Embassy 实时面板<\/title>/u);
    assert.match(document, />打开 Embassy 实时面板<\/a>/u);
    assert.doesNotMatch(document, /hreflang/u);
    assert.match(
      document,
      /http:\/\/127\.0\.0\.1:48123\/abcdefghijklmnopqrstuv\/bootstrap#[A-Za-z0-9_-]{43}/u,
    );
    assert.equal(document.includes("?" + artifacts.capability), false);
    assert.equal(document.includes(`#${artifacts.capability}`), true);
    assert.equal((await stat(path.dirname(artifacts.bootstrapPath))).mode & 0o077, 0);
    assert.equal((await stat(artifacts.bootstrapPath)).mode & 0o177, 0);
    const runDirectory = path.dirname(artifacts.bootstrapPath);
    await artifacts.close();
    await assert.rejects(stat(runDirectory), /ENOENT/u);
    await artifacts.close();
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
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
  assert.match(writer.frames.at(-1) ?? "", /"reset":true/u);
  writer.disconnect();
  assert.equal(clock.intervalCount(), 0);
  assert.equal(hub.streamCount(), 0);
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
      port: 0;
      exclusive: true;
      signal?: AbortSignal;
    }>;
  };
}>;

function fakeHttpHarness(
  address: Readonly<{
    address: string;
    family: string;
    port: number;
  }> = { address: "127.0.0.1", family: "IPv4", port: 48123 },
  options: Readonly<{ blockedConnection?: boolean }> = {},
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
          port: 0;
          exclusive: true;
          signal?: AbortSignal;
        }>
      | undefined,
    listen(
      options: Readonly<{
        host: "127.0.0.1";
        port: 0;
        exclusive: true;
        signal?: AbortSignal;
      }>,
    ) {
      this.listenOptions = options;
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
      if (options.blockedConnection === true) {
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

test("top-level start is ready only after verified loopback bind and private bootstrap", async () => {
  const temporary = path.join(
    os.tmpdir(),
    `embassy-live-start-${process.pid}-${Date.now()}`,
  );
  await mkdir(temporary, { mode: 0o700 });
  await chmod(temporary, 0o700);
  const harness = fakeHttpHarness();
  let randomCall = 0;
  let observerCalls = 0;
  let openedPath: string | undefined;
  try {
    const running = await startLiveDashboard({
      privateStateRoot: temporary,
      locale: "zh-CN",
      observer: {
        observe: async () => {
          observerCalls += 1;
          return { snapshotRevision: 0, snapshot: dashboardFixture() };
        },
      },
      dependencies: {
        http: harness.factory,
        random: (size) => new Uint8Array(size).fill(++randomCall),
        openBootstrap: (bootstrapPath) => {
          openedPath = bootstrapPath;
        },
      },
    });
    assert.deepEqual(running.address, { host: "127.0.0.1", port: 48123 });
    assert.equal(openedPath, running.bootstrapPath);
    const bootstrapDocument = await readFile(running.bootstrapPath, "utf8");
    assert.match(bootstrapDocument, /<html lang="zh-CN">/u);
    assert.match(bootstrapDocument, /打开 Embassy 实时面板/u);
    assert.equal(observerCalls, 0);
    assert.deepEqual(harness.server.listenOptions, {
      host: "127.0.0.1",
      port: 0,
      exclusive: true,
    });
    assert.equal(harness.server.maxConnections, LIVE_DASHBOARD_LIMITS.maximumConnections);
    assert.equal(harness.server.headersTimeout, LIVE_DASHBOARD_LIMITS.headersTimeoutMs);
    assert.equal((await stat(running.bootstrapPath)).mode & 0o177, 0);
    const runDirectory = path.dirname(running.bootstrapPath);
    await running.close();
    assert.equal(harness.server.closed, true);
    await assert.rejects(stat(runDirectory), /ENOENT/u);
    await running.close();
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("shutdown force-closes a blocked connection and exact-cleans bootstrap state", async () => {
  const temporary = path.join(
    os.tmpdir(),
    `embassy-live-blocked-close-${process.pid}-${Date.now()}`,
  );
  await mkdir(temporary, { mode: 0o700 });
  await chmod(temporary, 0o700);
  const harness = fakeHttpHarness(
    { address: "127.0.0.1", family: "IPv4", port: 48123 },
    { blockedConnection: true },
  );
  let running: Awaited<ReturnType<typeof startLiveDashboard>> | undefined;
  try {
    running = await startLiveDashboard({
      privateStateRoot: temporary,
      observer: {
        observe: async () => ({
          snapshotRevision: 0,
          snapshot: dashboardFixture(),
        }),
      },
      dependencies: {
        http: harness.factory,
        random: (size) => new Uint8Array(size).fill(1),
        openBootstrap: () => undefined,
      },
    });
    const runDirectory = path.dirname(running.bootstrapPath);
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
    await assert.rejects(stat(runDirectory), /ENOENT/u);
    assert.deepEqual(await readdir(temporary), []);
    running = undefined;
  } finally {
    await running?.close().catch(() => undefined);
    await rm(temporary, { recursive: true, force: true });
  }
});

test("real loopback composition exchanges a fragment session, streams, and exact-cleans", async () => {
  const temporary = path.join(
    os.tmpdir(),
    `embassy-live-http-smoke-${process.pid}-${Date.now()}`,
  );
  await mkdir(temporary, { mode: 0o700 });
  await chmod(temporary, 0o700);
  let randomCall = 0;
  let observerCalls = 0;
  let openedPath: string | undefined;
  let running: Awaited<ReturnType<typeof startLiveDashboard>> | undefined;
  try {
    running = await startLiveDashboard({
      privateStateRoot: temporary,
      observer: {
        observe: async () => {
          observerCalls += 1;
          return { snapshotRevision: 1, snapshot: dashboardFixture() };
        },
      },
      dependencies: {
        random: (size) => new Uint8Array(size).fill(++randomCall),
        openBootstrap: (bootstrapPath) => {
          openedPath = bootstrapPath;
        },
      },
    });
    assert.equal(openedPath, running.bootstrapPath);
    const runDirectory = path.dirname(running.bootstrapPath);
    const bootstrapDocument = await readFile(running.bootstrapPath, "utf8");
    const targetMatch =
      /http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/[A-Za-z0-9_-]{22}\/bootstrap#[A-Za-z0-9_-]{43}/u.exec(
        bootstrapDocument,
      );
    assert.ok(targetMatch);
    const bootstrapUrl = new URL(targetMatch[0]);
    const capability = bootstrapUrl.hash.slice(1);
    assert.equal(capability.length, 43);
    bootstrapUrl.hash = "";
    assert.deepEqual(
      { host: bootstrapUrl.hostname, port: Number(bootstrapUrl.port) },
      running.address,
    );

    const shell = await requestHttpSmoke(bootstrapUrl);
    assert.equal(shell.statusCode, 200);
    assert.match(shell.body, /id="root"/u);
    assert.equal(shell.body.includes(capability), false);
    assert.equal(shell.headers["cache-control"], "no-store");

    const sessionUrl = new URL("session", bootstrapUrl);
    const sessionHeaders = {
      Origin: bootstrapUrl.origin,
      "X-Embassy-Request": "1",
      "Content-Type": "text/plain",
      "Content-Length": String(Buffer.byteLength(capability, "utf8")),
    };
    const session = await requestHttpSmoke(sessionUrl, {
      method: "POST",
      headers: sessionHeaders,
      body: capability,
    });
    assert.equal(session.statusCode, 204);
    const setCookie = session.headers["set-cookie"]?.[0];
    assert.ok(setCookie);
    assert.match(setCookie, /; HttpOnly; SameSite=Strict$/u);
    assert.doesNotMatch(setCookie, /Domain|Expires|Max-Age|Secure/u);
    const cookie = setCookie.split(";", 1)[0]!;

    const replay = await requestHttpSmoke(sessionUrl, {
      method: "POST",
      headers: sessionHeaders,
      body: capability,
    });
    assert.equal(replay.statusCode, 403);

    const streamUrl = new URL("stream", bootstrapUrl);
    const stream = await openHttpSmokeStream(streamUrl, {
      Origin: bootstrapUrl.origin,
      "X-Embassy-Request": "1",
      Cookie: cookie,
      "Content-Length": "0",
    });
    assert.equal(stream.response.statusCode, 200);
    assert.match(stream.firstFrame, /^id: 1\nevent: snapshot\ndata: /u);
    assert.match(stream.firstFrame, /"snapshotRevision":1/u);
    assert.equal(observerCalls, 1);

    await running.close();
    await stream.ended;
    running = undefined;
    await assert.rejects(stat(runDirectory), /ENOENT/u);
    assert.deepEqual(await readdir(temporary), []);
  } finally {
    await running?.close().catch(() => undefined);
    await rm(temporary, { recursive: true, force: true });
  }
});

test("a pre-aborted start creates no server, randomness, file, or observation side effect", async () => {
  const temporary = path.join(
    os.tmpdir(),
    `embassy-live-preabort-${process.pid}-${Date.now()}`,
  );
  await mkdir(temporary, { mode: 0o700 });
  await chmod(temporary, 0o700);
  const harness = fakeHttpHarness();
  const controller = new AbortController();
  controller.abort();
  let serverCreations = 0;
  let randomCalls = 0;
  let observerCalls = 0;
  try {
    await assert.rejects(
      startLiveDashboard({
        privateStateRoot: temporary,
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
          random: (size) => {
            randomCalls += 1;
            return new Uint8Array(size);
          },
        },
      }),
      isLiveDashboardStartupCancelled,
    );
    assert.equal(serverCreations, 0);
    assert.equal(randomCalls, 0);
    assert.equal(observerCalls, 0);
    assert.deepEqual(await readdir(temporary), []);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("abort during a hung bootstrap closes the listener and exact-cleans late completion", async () => {
  const temporary = path.join(
    os.tmpdir(),
    `embassy-live-hung-bootstrap-${process.pid}-${Date.now()}`,
  );
  await mkdir(temporary, { mode: 0o700 });
  await chmod(temporary, 0o700);
  const harness = fakeHttpHarness();
  const controller = new AbortController();
  let randomCall = 0;
  let openerCalls = 0;
  let observerCalls = 0;
  let releaseOpen = (): void => {};
  let markOpenStarted = (): void => {};
  let markLateCleanup = (): void => {};
  const openGate = new Promise<void>((resolve) => {
    releaseOpen = resolve;
  });
  const openStarted = new Promise<void>((resolve) => {
    markOpenStarted = resolve;
  });
  const lateCleanup = new Promise<void>((resolve) => {
    markLateCleanup = resolve;
  });
  const fileSystem: LiveDashboardFileSystem = {
    ...defaultLiveDashboardFileSystem,
    open: async (pathname, flags, mode) => {
      markOpenStarted();
      await openGate;
      return await defaultLiveDashboardFileSystem.open(pathname, flags, mode);
    },
    rmdir: async (pathname) => {
      await defaultLiveDashboardFileSystem.rmdir(pathname);
      markLateCleanup();
    },
  };
  try {
    const starting = startLiveDashboard({
      privateStateRoot: temporary,
      locale: "zh-CN",
      signal: controller.signal,
      observer: {
        observe: async () => {
          observerCalls += 1;
          return { snapshotRevision: 0, snapshot: dashboardFixture() };
        },
      },
      dependencies: {
        fileSystem,
        http: harness.factory,
        random: (size) => new Uint8Array(size).fill(++randomCall),
        openBootstrap: () => {
          openerCalls += 1;
        },
      },
    });
    await openStarted;
    assert.equal(harness.server.closed, false);
    const startupResponse = {
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
      {} as IncomingMessage,
      startupResponse as unknown as ServerResponse,
    );
    assert.equal(startupResponse.statusCode, 503);
    assert.equal(startupResponse.body, "面板正在启动。\n");
    assert.equal(
      startupResponse.headers["Content-Length"],
      String(Buffer.byteLength(startupResponse.body, "utf8")),
    );
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
    assert.equal(openerCalls, 0);
    assert.equal(observerCalls, 0);

    releaseOpen();
    await lateCleanup;
    assert.deepEqual(await readdir(temporary), []);
  } finally {
    releaseOpen();
    await rm(temporary, { recursive: true, force: true });
  }
});

test("post-bind verification rejects every non-IPv4-loopback address", async () => {
  for (const address of [
    { address: "::1", family: "IPv6", port: 48123 },
    { address: "0.0.0.0", family: "IPv4", port: 48123 },
    { address: "127.0.0.1", family: "IPv4", port: 0 },
  ]) {
    const harness = fakeHttpHarness(address);
    await assert.rejects(
      bindLiveDashboardServer(harness.server),
      /LIVE_DASHBOARD_BIND_NOT_IPV4_LOOPBACK/u,
    );
    assert.equal(harness.server.closed, true);
  }
});
