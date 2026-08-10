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

const HOST = "127.0.0.1:41961";
const ORIGIN = `http://${HOST}`;
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
    expectedHost: HOST,
    expectedOrigin: ORIGIN,
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

function actionHeaders(body: string): string[] {
  return postHeaders([
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

function assertNoSetCookie(response: SyntheticResponse): void {
  assert.equal(
    Object.keys(response.headers).some(
      (name) => name.toLowerCase() === "set-cookie",
    ),
    false,
  );
}

test("serves only the three inert same-origin assets with security headers", async () => {
  const handler = createHandler();
  const fixtures = [
    ["/", ASSETS.shellHtml, "text/html; charset=utf-8"],
    ["/client.js", ASSETS.clientJavaScript, "text/javascript; charset=utf-8"],
    ["/app.css", ASSETS.styleSheet, "text/css; charset=utf-8"],
  ] as const;

  for (const [target, body, contentType] of fixtures) {
    const response = await invoke(handler, {
      method: "GET",
      target,
      rawHeaders: navigationHeaders(),
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.bodyText(), body);
    assert.equal(response.headers["Content-Type"], contentType);
    assertSecurityHeaders(response);
  }

  const shell = await invoke(handler, {
    method: "GET",
    target: "/",
    rawHeaders: navigationHeaders(),
  });
  assert.match(shell.headers["Content-Security-Policy"] ?? "", /connect-src 'self'/u);

  for (const target of [
    "/?debug=1",
    "/missing",
    "/bootstrap",
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
        target: "/",
        rawHeaders: ["Host", HOST, "Host", HOST],
      }),
    ],
    [
      403,
      "禁止访问。\n",
      invoke(createHandler(undefined, "zh-CN"), {
        method: "POST",
        target: "/snapshot",
        rawHeaders: ["Host", HOST, "Origin", ORIGIN],
      }),
    ],
    [
      404,
      "未找到。\n",
      invoke(createHandler(undefined, "zh-CN"), {
        method: "GET",
        target: "/missing",
        rawHeaders: navigationHeaders(),
      }),
    ],
    [
      405,
      "不允许使用此方法。\n",
      invoke(createHandler(undefined, "zh-CN"), {
        method: "OPTIONS",
        target: "/snapshot",
        rawHeaders: postHeaders(),
      }),
    ],
    [
      413,
      "请求正文过大。\n",
      invoke(createHandler(undefined, "zh-CN"), {
        method: "POST",
        target: "/action",
        rawHeaders: postHeaders([
          "Content-Type",
          "application/json",
          "Content-Length",
          String(LIVE_DASHBOARD_LIMITS.maximumActionBodyBytes + 1),
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
        target: "/action",
        rawHeaders: postHeaders([
          "Content-Type",
          "text/plain",
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
          target: "/stream",
          rawHeaders: postHeaders(),
        },
      ),
    ],
    [
      431,
      "请求头过大。\n",
      invoke(createHandler(undefined, "zh-CN"), {
        method: "GET",
        target: "/",
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
        target: "/snapshot",
        rawHeaders: postHeaders(),
      }),
    ],
    [
      500,
      "请求失败。\n",
      invoke(createHandler(new FailingHub(), "zh-CN"), {
        method: "POST",
        target: "/snapshot",
        rawHeaders: postHeaders(),
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

test("rejects bodies on empty-post API routes", async () => {
  const handler = createHandler();

  const bodyOnSnapshot = await invoke(handler, {
    method: "POST",
    target: "/snapshot",
    rawHeaders: postHeaders(["Content-Length", "1"]),
    body: "x",
  });
  assert.equal(bodyOnSnapshot.statusCode, 400);
  assertSecurityHeaders(bodyOnSnapshot);
});

test("requires exact Host, Origin, and request marker on every API route", async () => {
  const handler = createHandler();
  const rejectedHeaders = [
    ["Origin", ORIGIN, "X-Embassy-Request", "1"],
    ["Host", HOST, "X-Embassy-Request", "1"],
    ["Host", HOST, "Origin", ORIGIN],
    ["Host", HOST, "Origin", ORIGIN, "X-Embassy-Request", "0"],
  ] as const;

  for (const target of ["/snapshot", "/stream", "/action"] as const) {
    for (const rawHeaders of rejectedHeaders) {
      const response = await invoke(handler, {
        method: "POST",
        target,
        rawHeaders: [...rawHeaders],
      });
      assert.equal(response.statusCode, 403, target);
      assertSecurityHeaders(response);
    }
  }
});

test("action route forwards only the four exact verbs", async () => {
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
      target: "/action",
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
      target: "/action",
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

test("action route rejects malformed or cross-origin requests before broker contact", async () => {
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
      headers: [
        "Origin",
        ORIGIN,
        "X-Embassy-Request",
        "1",
        "Content-Type",
        "application/json",
        "Content-Length",
        String(Buffer.byteLength(validBody)),
      ],
      body: validBody,
      status: 403,
    },
    {
      method: "POST",
      headers: actionHeaders(validBody).map((value, index) =>
        index === 1 ? "localhost:41961" : value,
      ),
      body: validBody,
      status: 403,
    },
    {
      method: "POST",
      headers: actionHeaders(validBody).map((value, index) =>
        index === 3 ? "http://localhost:41961" : value,
      ),
      body: validBody,
      status: 403,
    },
    {
      method: "POST",
      headers: postHeaders([
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
      headers: postHeaders([
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
      headers: postHeaders(["Content-Type", "application/json"]),
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
      target: "/action",
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
      target: "/action",
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
        target: "/action",
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
      headers: postHeaders([], "localhost:41961"),
      expected: 403,
    },
    {
      method: "POST",
      headers: postHeaders([], HOST, "http://localhost:41961"),
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
      target: "/snapshot",
      rawHeaders: [...fixture.headers],
    });
    assert.equal(response.statusCode, fixture.expected);
    assertSecurityHeaders(response);
  }

  const duplicateRequestMarker = await invoke(handler, {
    method: "POST",
    target: "/snapshot",
    rawHeaders: [...postHeaders(), "X-Embassy-Request", "1"],
  });
  assert.equal(duplicateRequestMarker.statusCode, 400);
});

test("allows two independent windows to use every API without cookies", async () => {
  const hub = new SyntheticHub();
  const actions = new SyntheticActions();
  const handler = createHandler(hub, "en", actions);
  const actionBody = JSON.stringify({ action: "refresh_dashboard" });

  const openWindow = async (): Promise<readonly SyntheticResponse[]> => {
    const shell = await invoke(handler, {
      method: "GET",
      target: "/",
      rawHeaders: navigationHeaders(),
    });
    const snapshot = await invoke(handler, {
      method: "POST",
      target: "/snapshot",
      rawHeaders: postHeaders(),
    });
    const action = await invoke(handler, {
      method: "POST",
      target: "/action",
      rawHeaders: actionHeaders(actionBody),
      body: actionBody,
    });
    const stream = await invoke(handler, {
      method: "POST",
      target: "/stream",
      rawHeaders: postHeaders(),
    });
    return [shell, snapshot, action, stream];
  };

  const firstWindow = await openWindow();
  const secondWindow = await openWindow();
  for (const [index, response] of [...firstWindow, ...secondWindow].entries()) {
    assert.equal(response.statusCode, 200, `response ${index + 1}`);
    assertNoSetCookie(response);
    assertSecurityHeaders(response);
  }
  assert.equal(hub.refreshCalled, 2);
  assert.equal(hub.addCalled, 2);
  assert.equal(actions.calls.length, 2);
});

test("performs a one-shot safe refresh without browser credentials", async () => {
  const hub = new SyntheticHub();
  const handler = createHandler(hub);
  const accepted = await invoke(handler, {
    method: "POST",
    target: "/snapshot",
    rawHeaders: postHeaders(),
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
    target: "/snapshot",
    rawHeaders: postHeaders(),
  });
  assert.equal(unavailable.statusCode, 503);
  assert.doesNotMatch(unavailable.bodyText(), /observer|exception|stack/iu);
});

test("attaches a same-origin SSE adapter and rejects a fifth stream", async () => {
  const hub = new SyntheticHub();
  const handler = createHandler(hub);
  const response = await invoke(handler, {
    method: "POST",
    target: "/stream",
    rawHeaders: postHeaders(),
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
    target: "/stream",
    rawHeaders: postHeaders(),
  });
  assert.equal(full.statusCode, 429);
  assert.equal(fullHub.addCalled, 0);
  assertSecurityHeaders(full);
});

test("rejects non-loopback and mismatched origins", () => {
  assert.throws(
    () =>
      createLiveDashboardRequestHandler({
        expectedHost: "localhost:41961",
        expectedOrigin: "http://localhost:41961",
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
        expectedHost: HOST,
        expectedOrigin: "http://127.0.0.1:43128",
        lang: "en",
        assets: ASSETS,
        hub: new SyntheticHub(),
        actions: new SyntheticActions(),
      }),
    /LIVE_DASHBOARD_ORIGIN_INVALID/u,
  );
});
