import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import test from "node:test";

import type { DashboardViewModel } from "../src/gateway/dashboard-model.js";
import type { DashboardLocale } from "../src/gateway/locale.js";
import {
  createLiveDashboardRequestHandler,
  type LiveDashboardAction,
  type LiveDashboardActionExecutor,
  type LiveDashboardActionResult,
  type LiveDashboardRequestHandler,
} from "../src/gateway/live-dashboard-http.js";
import { LIVE_DASHBOARD_LIMITS } from "../src/gateway/live-dashboard-protocol.js";
import type {
  LiveDashboardStreamEvent,
  LiveDashboardStreamHub,
  LiveDashboardStreamWriter,
} from "../src/gateway/live-dashboard-stream.js";

const INSTANCE_PATH = "/instance_0123456789abcdef";
const HOST = "127.0.0.1:43127";
const ORIGIN = `http://${HOST}`;
const COOKIE_NAME = "embassy_live";
const CAPABILITY = Buffer.alloc(32, 0x31).toString("base64url");
const SESSION_SECRET = Buffer.alloc(32, 0x73).toString("base64url");
const ASSETS = Object.freeze({
  shellHtml: "<!doctype html><title>Embassy live</title>",
  clientJavaScript: "globalThis.embassyLive = true;",
  styleSheet: ":root { color-scheme: light; }",
  appJavaScript: "var Embassy;",
  vendorReactJavaScript: "globalThis.React = {};",
  vendorReactDomJavaScript: "globalThis.ReactDOM = {};",
});

const LATEST: LiveDashboardStreamEvent = Object.freeze({
  streamRevision: 7,
  snapshotRevision: "snapshot-6",
  reset: false,
  model: Object.freeze({}) as DashboardViewModel,
});

class SyntheticRequest extends EventEmitter {
  constructor(
    readonly method: string,
    readonly url: string,
    readonly rawHeaders: string[],
  ) {
    super();
  }
}

class SyntheticResponse extends EventEmitter {
  statusCode: number | undefined;
  readonly headers: Record<string, string> = {};
  readonly chunks: Buffer[] = [];
  headersSent = false;
  writableEnded = false;
  writeAccepted = true;

  writeHead(statusCode: number, headers: Record<string, string>): this {
    this.statusCode = statusCode;
    Object.assign(this.headers, headers);
    this.headersSent = true;
    return this;
  }

  write(chunk: string | Buffer): boolean {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return this.writeAccepted;
  }

  end(chunk?: string | Buffer): this {
    if (chunk !== undefined) this.write(chunk);
    this.writableEnded = true;
    return this;
  }

  bodyText(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }
}

class SyntheticHub implements LiveDashboardStreamHub {
  writer: LiveDashboardStreamWriter | undefined;
  addCalled = 0;
  refreshCalled = 0;

  constructor(
    private readonly event: LiveDashboardStreamEvent | null = LATEST,
    private readonly count = 0,
    private readonly rejectAdd = false,
  ) {}

  add(
    writer: LiveDashboardStreamWriter,
  ):
    | Readonly<{ ok: true; close(): void }>
    | Readonly<{ ok: false; safeCode: "LIVE_STREAM_LIMIT" }> {
    this.addCalled += 1;
    if (this.rejectAdd) {
      return { ok: false, safeCode: "LIVE_STREAM_LIMIT" };
    }
    this.writer = writer;
    return { ok: true, close: () => undefined };
  }

  latest(): LiveDashboardStreamEvent | undefined {
    return this.event ?? undefined;
  }

  async pollNow(): Promise<void> {}

  async refresh(): Promise<LiveDashboardStreamEvent | undefined> {
    this.refreshCalled += 1;
    return this.event ?? undefined;
  }

  shutdown(): void {}

  streamCount(): number {
    return this.count;
  }
}

class SyntheticActions implements LiveDashboardActionExecutor {
  readonly calls: LiveDashboardAction[] = [];

  constructor(
    readonly result: LiveDashboardActionResult = { ok: true, code: "ok" },
  ) {}

  async execute(action: LiveDashboardAction): Promise<LiveDashboardActionResult> {
    this.calls.push(action);
    return this.result;
  }
}

function createHandler(
  hub: LiveDashboardStreamHub = new SyntheticHub(),
  lang: DashboardLocale = "en",
  actions: LiveDashboardActionExecutor = new SyntheticActions(),
  now?: () => number,
): LiveDashboardRequestHandler {
  return createLiveDashboardRequestHandler({
    instancePath: INSTANCE_PATH,
    expectedHost: HOST,
    expectedOrigin: ORIGIN,
    capability: CAPABILITY,
    sessionSecret: SESSION_SECRET,
    cookieName: COOKIE_NAME,
    lang,
    assets: ASSETS,
    hub,
    actions,
    ...(now === undefined ? {} : { now }),
  });
}

function navigationHeaders(): string[] {
  return ["Host", HOST];
}

function postHeaders(
  additions: readonly string[] = [],
  host = HOST,
  origin = ORIGIN,
): string[] {
  return [
    "Host",
    host,
    "Origin",
    origin,
    "X-Embassy-Request",
    "1",
    ...additions,
  ];
}

function authenticatedHeaders(additions: readonly string[] = []): string[] {
  return postHeaders([
    "Cookie",
    `${COOKIE_NAME}=${SESSION_SECRET}`,
    ...additions,
  ]);
}

function actionHeaders(body: string): string[] {
  return authenticatedHeaders([
    "Content-Type",
    "application/json",
    "Content-Length",
    String(Buffer.byteLength(body, "utf8")),
  ]);
}

async function invoke(
  handler: LiveDashboardRequestHandler,
  input: Readonly<{
    method: string;
    target: string;
    rawHeaders: string[];
    body?: string | Buffer;
  }>,
): Promise<SyntheticResponse> {
  const request = new SyntheticRequest(
    input.method,
    input.target,
    input.rawHeaders,
  );
  const response = new SyntheticResponse();
  const result = handler(
    request as unknown as IncomingMessage,
    response as unknown as ServerResponse,
  );
  if (input.body !== undefined) request.emit("data", input.body);
  request.emit("end");
  await result;
  return response;
}

function assertSecurityHeaders(response: SyntheticResponse): void {
  assert.equal(response.headers["Cache-Control"], "no-store");
  assert.equal(response.headers.Pragma, "no-cache");
  assert.equal(response.headers["X-Content-Type-Options"], "nosniff");
  assert.equal(response.headers["X-Frame-Options"], "DENY");
  assert.equal(response.headers["Access-Control-Allow-Origin"], undefined);
  assert.equal(response.headers["Access-Control-Allow-Credentials"], undefined);
}

test("serves only the three inert same-origin assets with security headers", async () => {
  const handler = createHandler();
  const fixtures = [
    ["bootstrap", ASSETS.shellHtml, "text/html; charset=utf-8"],
    ["client.js", ASSETS.clientJavaScript, "text/javascript; charset=utf-8"],
    ["app.css", ASSETS.styleSheet, "text/css; charset=utf-8"],
  ] as const;

  for (const [leaf, body, contentType] of fixtures) {
    const response = await invoke(handler, {
      method: "GET",
      target: `${INSTANCE_PATH}/${leaf}`,
      rawHeaders: navigationHeaders(),
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.bodyText(), body);
    assert.equal(response.headers["Content-Type"], contentType);
    assertSecurityHeaders(response);
  }

  const shell = await invoke(handler, {
    method: "GET",
    target: `${INSTANCE_PATH}/bootstrap`,
    rawHeaders: navigationHeaders(),
  });
  assert.match(shell.headers["Content-Security-Policy"] ?? "", /connect-src 'self'/u);

  for (const target of [
    `${INSTANCE_PATH}/bootstrap?debug=1`,
    `${INSTANCE_PATH}/missing`,
    `${INSTANCE_PATH}/`,
  ]) {
    const response = await invoke(handler, {
      method: "GET",
      target,
      rawHeaders: navigationHeaders(),
    });
    assert.equal(response.statusCode, 404);
    assertSecurityHeaders(response);
  }
});

test("localizes every human HTTP fallback without changing status or security headers", async () => {
  class FailingHub extends SyntheticHub {
    override async refresh(): Promise<LiveDashboardStreamEvent | undefined> {
      throw new Error("synthetic refresh failure");
    }
  }

  const fixtures: ReadonlyArray<
    readonly [number, string, Promise<SyntheticResponse>]
  > = [
    [
      400,
      "请求无效。\n",
      invoke(createHandler(undefined, "zh-CN"), {
        method: "GET",
        target: `${INSTANCE_PATH}/bootstrap`,
        rawHeaders: ["Host", HOST, "Host", HOST],
      }),
    ],
    [
      403,
      "禁止访问。\n",
      invoke(createHandler(undefined, "zh-CN"), {
        method: "POST",
        target: `${INSTANCE_PATH}/snapshot`,
        rawHeaders: ["Host", HOST, "Origin", ORIGIN],
      }),
    ],
    [
      404,
      "未找到。\n",
      invoke(createHandler(undefined, "zh-CN"), {
        method: "GET",
        target: `${INSTANCE_PATH}/missing`,
        rawHeaders: navigationHeaders(),
      }),
    ],
    [
      405,
      "不允许使用此方法。\n",
      invoke(createHandler(undefined, "zh-CN"), {
        method: "OPTIONS",
        target: `${INSTANCE_PATH}/snapshot`,
        rawHeaders: postHeaders(),
      }),
    ],
    [
      413,
      "请求正文过大。\n",
      invoke(createHandler(undefined, "zh-CN"), {
        method: "POST",
        target: `${INSTANCE_PATH}/session`,
        rawHeaders: postHeaders([
          "Content-Type",
          "text/plain",
          "Content-Length",
          String(LIVE_DASHBOARD_LIMITS.maximumSessionBodyBytes + 1),
        ]),
      }),
    ],
    [
      414,
      "请求目标过长。\n",
      invoke(createHandler(undefined, "zh-CN"), {
        method: "GET",
        target: `/${"x".repeat(LIVE_DASHBOARD_LIMITS.maximumRequestTargetBytes)}`,
        rawHeaders: navigationHeaders(),
      }),
    ],
    [
      415,
      "不支持此媒体类型。\n",
      invoke(createHandler(undefined, "zh-CN"), {
        method: "POST",
        target: `${INSTANCE_PATH}/session`,
        rawHeaders: postHeaders([
          "Content-Type",
          "application/json",
          "Content-Length",
          "0",
        ]),
      }),
    ],
    [
      429,
      "实时流数量过多。\n",
      invoke(
        createHandler(
          new SyntheticHub(LATEST, LIVE_DASHBOARD_LIMITS.maximumStreams),
          "zh-CN",
        ),
        {
          method: "POST",
          target: `${INSTANCE_PATH}/stream`,
          rawHeaders: authenticatedHeaders(),
        },
      ),
    ],
    [
      431,
      "请求头过大。\n",
      invoke(createHandler(undefined, "zh-CN"), {
        method: "GET",
        target: `${INSTANCE_PATH}/bootstrap`,
        rawHeaders: [
          "Host",
          HOST,
          "X-Fill",
          "x".repeat(LIVE_DASHBOARD_LIMITS.maximumHeaderBytes),
        ],
      }),
    ],
    [
      503,
      "面板快照不可用。\n",
      invoke(createHandler(new SyntheticHub(null), "zh-CN"), {
        method: "POST",
        target: `${INSTANCE_PATH}/snapshot`,
        rawHeaders: authenticatedHeaders(),
      }),
    ],
    [
      500,
      "请求失败。\n",
      invoke(createHandler(new FailingHub(), "zh-CN"), {
        method: "POST",
        target: `${INSTANCE_PATH}/snapshot`,
        rawHeaders: authenticatedHeaders(),
      }),
    ],
  ];

  for (const [statusCode, body, responsePromise] of fixtures) {
    const response = await responsePromise;
    assert.equal(response.statusCode, statusCode);
    assert.equal(response.bodyText(), body);
    assert.equal(
      response.headers["Content-Length"],
      String(Buffer.byteLength(body, "utf8")),
    );
    assertSecurityHeaders(response);
  }
});

test("exchanges the fragment capability exactly once for a scoped session cookie", async () => {
  const handler = createHandler();
  const wrong = "x".repeat(CAPABILITY.length);
  const sessionHeaders = (
    body: string,
    contentType = "text/plain",
  ): string[] =>
    postHeaders([
      "Content-Type",
      contentType,
      "Content-Length",
      String(Buffer.byteLength(body)),
    ]);

  const rejected = await invoke(handler, {
    method: "POST",
    target: `${INSTANCE_PATH}/session`,
    rawHeaders: sessionHeaders(wrong),
    body: wrong,
  });
  assert.equal(rejected.statusCode, 403);

  const accepted = await invoke(handler, {
    method: "POST",
    target: `${INSTANCE_PATH}/session`,
    rawHeaders: sessionHeaders(CAPABILITY, "text/plain;charset=UTF-8"),
    body: CAPABILITY,
  });
  assert.equal(accepted.statusCode, 204);
  assert.equal(accepted.bodyText(), "");
  assert.equal(
    accepted.headers["Set-Cookie"],
    `${COOKIE_NAME}=${SESSION_SECRET}; Path=${INSTANCE_PATH}/; HttpOnly; SameSite=Strict`,
  );
  assertSecurityHeaders(accepted);

  const replayed = await invoke(handler, {
    method: "POST",
    target: `${INSTANCE_PATH}/session`,
    rawHeaders: sessionHeaders(CAPABILITY),
    body: CAPABILITY,
  });
  assert.equal(replayed.statusCode, 403);
});

test("enforces body framing and the bounded text capability protocol", async () => {
  const handler = createHandler();

  const wrongMediaType = await invoke(handler, {
    method: "POST",
    target: `${INSTANCE_PATH}/session`,
    rawHeaders: postHeaders([
      "Content-Type",
      "application/json",
      "Content-Length",
      "2",
    ]),
    body: "{}",
  });
  assert.equal(wrongMediaType.statusCode, 415);

  const tooLarge = "z".repeat(
    LIVE_DASHBOARD_LIMITS.maximumSessionBodyBytes + 1,
  );
  const oversized = await invoke(handler, {
    method: "POST",
    target: `${INSTANCE_PATH}/session`,
    rawHeaders: postHeaders([
      "Content-Type",
      "text/plain",
      "Content-Length",
      String(Buffer.byteLength(tooLarge)),
    ]),
    body: tooLarge,
  });
  assert.equal(oversized.statusCode, 413);

  const bodyOnSnapshot = await invoke(handler, {
    method: "POST",
    target: `${INSTANCE_PATH}/snapshot`,
    rawHeaders: authenticatedHeaders(["Content-Length", "1"]),
    body: "x",
  });
  assert.equal(bodyOnSnapshot.statusCode, 400);
  assertSecurityHeaders(bodyOnSnapshot);
});

test("action route forwards only the four exact authenticated verbs", async () => {
  const actions = new SyntheticActions();
  const handler = createHandler(undefined, "en", actions);
  const fixtures: LiveDashboardAction[] = [
    {
      action: "pair",
      claudeAlias: "claude-advisor@this-mac",
      codexAlias: "codex-builder@this-mac",
    },
    {
      action: "unpair",
      claudeAlias: "claude-advisor@this-mac",
      codexAlias: "codex-builder@this-mac",
    },
    {
      action: "remove_stale_codex_registration",
      alias: "codex-orphan@this-mac",
    },
    { action: "refresh_dashboard" },
  ];

  for (const action of fixtures) {
    const body = JSON.stringify(action);
    const response = await invoke(handler, {
      method: "POST",
      target: `${INSTANCE_PATH}/action`,
      rawHeaders: actionHeaders(body),
      body,
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(JSON.parse(response.bodyText()), {
      ok: true,
      code: "ok",
    });
    assertSecurityHeaders(response);
  }
  assert.deepEqual(actions.calls, fixtures);

  const refused = new SyntheticActions({ ok: false, code: "busy" });
  const refusedBody = JSON.stringify({ action: "refresh_dashboard" });
  const refusedResponse = await invoke(
    createHandler(undefined, "en", refused),
    {
      method: "POST",
      target: `${INSTANCE_PATH}/action`,
      rawHeaders: actionHeaders(refusedBody),
      body: refusedBody,
    },
  );
  assert.equal(refusedResponse.statusCode, 200);
  assert.deepEqual(JSON.parse(refusedResponse.bodyText()), {
    ok: false,
    code: "busy",
  });
});

test("action route rejects malformed or unauthenticated requests before broker contact", async () => {
  const actions = new SyntheticActions();
  const handler = createHandler(undefined, "en", actions);
  const validBody = JSON.stringify({ action: "refresh_dashboard" });
  const cases: ReadonlyArray<
    Readonly<{
      method: string;
      headers: string[];
      body?: string;
      status: number;
    }>
  > = [
    { method: "GET", headers: navigationHeaders(), status: 405 },
    {
      method: "PUT",
      headers: actionHeaders(validBody),
      body: validBody,
      status: 405,
    },
    {
      method: "DELETE",
      headers: actionHeaders(validBody),
      body: validBody,
      status: 405,
    },
    {
      method: "POST",
      headers: actionHeaders(validBody).filter(
        (_value, index) => index < 2 || index > 3,
      ),
      body: validBody,
      status: 403,
    },
    {
      method: "POST",
      headers: actionHeaders(validBody).filter(
        (_value, index) => index < 4 || index > 5,
      ),
      body: validBody,
      status: 403,
    },
    {
      method: "POST",
      headers: postHeaders([
        "Content-Type",
        "application/json",
        "Content-Length",
        String(Buffer.byteLength(validBody)),
      ]),
      body: validBody,
      status: 403,
    },
    {
      method: "POST",
      headers: actionHeaders(validBody).map((value, index) =>
        index === 1 ? "localhost:43127" : value,
      ),
      body: validBody,
      status: 403,
    },
    {
      method: "POST",
      headers: actionHeaders(validBody).map((value, index) =>
        index === 3 ? "http://localhost:43127" : value,
      ),
      body: validBody,
      status: 403,
    },
    {
      method: "POST",
      headers: authenticatedHeaders([
        "Content-Type",
        "text/plain",
        "Content-Length",
        String(Buffer.byteLength(validBody)),
      ]),
      body: validBody,
      status: 415,
    },
    {
      method: "POST",
      headers: authenticatedHeaders([
        "Content-Type",
        "application/json",
        "Content-Length",
        String(LIVE_DASHBOARD_LIMITS.maximumActionBodyBytes + 1),
      ]),
      status: 413,
    },
    {
      method: "POST",
      headers: actionHeaders("not-json"),
      body: "not-json",
      status: 400,
    },
    {
      method: "POST",
      headers: actionHeaders(
        '{"action":"remove_stale_codex_registration","alias":"claude-advisor@this-mac"}',
      ),
      body: '{"action":"remove_stale_codex_registration","alias":"claude-advisor@this-mac"}',
      status: 400,
    },
    {
      method: "POST",
      headers: actionHeaders(
        '{"action":"remove_stale_codex_registration","alias":"codex-orphan@this-mac","threadId":"private"}',
      ),
      body: '{"action":"remove_stale_codex_registration","alias":"codex-orphan@this-mac","threadId":"private"}',
      status: 400,
    },
    {
      method: "POST",
      headers: actionHeaders('{"action":"send_to_codex"}'),
      body: '{"action":"send_to_codex"}',
      status: 400,
    },
    {
      method: "POST",
      headers: authenticatedHeaders(["Content-Type", "application/json"]),
      body: validBody,
      status: 400,
    },
    {
      method: "POST",
      headers: actionHeaders(
        '{"action":"refresh_dashboard","extra":true}',
      ),
      body: '{"action":"refresh_dashboard","extra":true}',
      status: 400,
    },
    {
      method: "POST",
      headers: actionHeaders(
        '{"action":"pair","claudeAlias":"NOT AN ALIAS","codexAlias":"codex-builder@this-mac"}',
      ),
      body: '{"action":"pair","claudeAlias":"NOT AN ALIAS","codexAlias":"codex-builder@this-mac"}',
      status: 400,
    },
  ];

  for (const fixture of cases) {
    const response = await invoke(handler, {
      method: fixture.method,
      target: `${INSTANCE_PATH}/action`,
      rawHeaders: fixture.headers,
      ...(fixture.body === undefined ? {} : { body: fixture.body }),
    });
    assert.equal(response.statusCode, fixture.status);
    assertSecurityHeaders(response);
  }
  assert.deepEqual(actions.calls, []);
});

test("action rate limit rejects the seventh request and refills linearly", async () => {
  let nowMs = 0;
  const actions = new SyntheticActions();
  const handler = createHandler(undefined, "en", actions, () => nowMs);
  const body = JSON.stringify({ action: "refresh_dashboard" });
  const invokeAction = async (): Promise<SyntheticResponse> =>
    await invoke(handler, {
      method: "POST",
      target: `${INSTANCE_PATH}/action`,
      rawHeaders: actionHeaders(body),
      body,
    });

  for (
    let index = 0;
    index < LIVE_DASHBOARD_LIMITS.maximumActionsPerMinute;
    index += 1
  ) {
    assert.equal((await invokeAction()).statusCode, 200);
  }
  const limited = await invokeAction();
  assert.equal(limited.statusCode, 429);
  assert.equal(limited.headers["Retry-After"], "10");
  assert.deepEqual(JSON.parse(limited.bodyText()), {
    ok: false,
    code: "rate_limited",
  });
  assert.equal(actions.calls.length, 6);

  nowMs = 10_000;
  assert.equal((await invokeAction()).statusCode, 200);
  assert.equal(actions.calls.length, 7);
});

test("action failures are normalized without leaking broker or exception detail", async () => {
  const body = JSON.stringify({ action: "refresh_dashboard" });
  const executors: LiveDashboardActionExecutor[] = [
    {
      execute: async () => {
        throw new Error("private control socket and stack detail");
      },
    },
    {
      execute: async () =>
        ({ ok: true, code: "busy" }) as LiveDashboardActionResult,
    },
  ];

  for (const executor of executors) {
    const response = await invoke(
      createHandler(undefined, "en", executor),
      {
        method: "POST",
        target: `${INSTANCE_PATH}/action`,
        rawHeaders: actionHeaders(body),
        body,
      },
    );
    assert.equal(response.statusCode, 503);
    assert.deepEqual(JSON.parse(response.bodyText()), {
      ok: false,
      code: "unavailable",
    });
    assert.doesNotMatch(response.bodyText(), /socket|stack|exception/iu);
    assertSecurityHeaders(response);
  }
});

test("delegates duplicate, forwarding, origin, and method rejection to strict validation", async () => {
  const handler = createHandler();
  const cases = [
    {
      method: "POST",
      headers: postHeaders([], "localhost:43127"),
      expected: 403,
    },
    {
      method: "POST",
      headers: postHeaders([], HOST, "http://localhost:43127"),
      expected: 403,
    },
    {
      method: "POST",
      headers: [...postHeaders(), "Host", HOST],
      expected: 400,
    },
    {
      method: "POST",
      headers: [...postHeaders(), "Forwarded", "for=127.0.0.1"],
      expected: 400,
    },
    {
      method: "POST",
      headers: [...postHeaders(), "Transfer-Encoding", "chunked"],
      expected: 400,
    },
    {
      method: "OPTIONS",
      headers: postHeaders(),
      expected: 405,
    },
  ] as const;

  for (const fixture of cases) {
    const response = await invoke(handler, {
      method: fixture.method,
      target: `${INSTANCE_PATH}/snapshot`,
      rawHeaders: [...fixture.headers],
    });
    assert.equal(response.statusCode, fixture.expected);
    assertSecurityHeaders(response);
  }

  const duplicateCookie = await invoke(handler, {
    method: "POST",
    target: `${INSTANCE_PATH}/snapshot`,
    rawHeaders: authenticatedHeaders([
      "Cookie",
      `${COOKIE_NAME}=${SESSION_SECRET}`,
    ]),
  });
  assert.equal(duplicateCookie.statusCode, 400);
});

test("requires the exact session cookie and performs a one-shot safe refresh", async () => {
  const hub = new SyntheticHub();
  const handler = createHandler(hub);
  const missing = await invoke(handler, {
    method: "POST",
    target: `${INSTANCE_PATH}/snapshot`,
    rawHeaders: postHeaders(),
  });
  assert.equal(missing.statusCode, 403);
  assert.equal(hub.refreshCalled, 0);

  const wrong = await invoke(handler, {
    method: "POST",
    target: `${INSTANCE_PATH}/snapshot`,
    rawHeaders: postHeaders([
      "Cookie",
      `${COOKIE_NAME}=${Buffer.alloc(32, 0x72).toString("base64url")}`,
    ]),
  });
  assert.equal(wrong.statusCode, 403);
  assert.equal(hub.refreshCalled, 0);

  const accepted = await invoke(handler, {
    method: "POST",
    target: `${INSTANCE_PATH}/snapshot`,
    rawHeaders: authenticatedHeaders(),
  });
  assert.equal(accepted.statusCode, 200);
  assert.equal(hub.refreshCalled, 1);
  assert.deepEqual(JSON.parse(accepted.bodyText()), LATEST);
  assert.equal(
    accepted.headers["Content-Type"],
    "application/json; charset=utf-8",
  );
  assertSecurityHeaders(accepted);

  const unavailableHandler = createHandler(new SyntheticHub(null));
  const unavailable = await invoke(unavailableHandler, {
    method: "POST",
    target: `${INSTANCE_PATH}/snapshot`,
    rawHeaders: authenticatedHeaders(),
  });
  assert.equal(unavailable.statusCode, 503);
  assert.doesNotMatch(unavailable.bodyText(), /observer|exception|stack/iu);
});

test("attaches an authenticated SSE adapter and rejects a fifth stream", async () => {
  const hub = new SyntheticHub();
  const handler = createHandler(hub);
  const response = await invoke(handler, {
    method: "POST",
    target: `${INSTANCE_PATH}/stream`,
    rawHeaders: authenticatedHeaders(),
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.writableEnded, false);
  assert.equal(response.headers["Content-Type"], "text/event-stream; charset=utf-8");
  assert.equal(hub.addCalled, 1);
  assertSecurityHeaders(response);

  const writer = hub.writer;
  assert.ok(writer);
  assert.equal(writer.write("event: test\ndata: {}\n\n"), true);
  assert.match(response.bodyText(), /event: test/u);

  let drained = false;
  writer.onDrain(() => {
    drained = true;
  });
  response.emit("drain");
  assert.equal(drained, true);

  let closed = false;
  writer.onClose(() => {
    closed = true;
  });
  response.emit("close");
  assert.equal(closed, true);
  writer.end();
  assert.equal(response.writableEnded, true);

  const fullHub = new SyntheticHub(
    LATEST,
    LIVE_DASHBOARD_LIMITS.maximumStreams,
  );
  const full = await invoke(createHandler(fullHub), {
    method: "POST",
    target: `${INSTANCE_PATH}/stream`,
    rawHeaders: authenticatedHeaders(),
  });
  assert.equal(full.statusCode, 429);
  assert.equal(fullHub.addCalled, 0);
  assertSecurityHeaders(full);
});

test("rejects invalid construction secrets and non-loopback origins", () => {
  assert.throws(
    () =>
      createLiveDashboardRequestHandler({
        instancePath: INSTANCE_PATH,
        expectedHost: "localhost:43127",
        expectedOrigin: "http://localhost:43127",
        capability: CAPABILITY,
        sessionSecret: SESSION_SECRET,
        cookieName: COOKIE_NAME,
        lang: "en",
        assets: ASSETS,
        hub: new SyntheticHub(),
        actions: new SyntheticActions(),
      }),
    /LIVE_DASHBOARD_ORIGIN_INVALID/u,
  );
  assert.throws(
    () =>
      createLiveDashboardRequestHandler({
        instancePath: INSTANCE_PATH,
        expectedHost: HOST,
        expectedOrigin: ORIGIN,
        capability: "not-a-capability",
        sessionSecret: SESSION_SECRET,
        cookieName: COOKIE_NAME,
        lang: "en",
        assets: ASSETS,
        hub: new SyntheticHub(),
        actions: new SyntheticActions(),
      }),
    /LIVE_DASHBOARD_CAPABILITY_INVALID/u,
  );
});
