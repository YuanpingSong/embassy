import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import test from "node:test";

import type { DashboardViewModel } from "../src/gateway/dashboard-model.js";
import type { DashboardLocale } from "../src/gateway/locale.js";
import { renderLiveDashboardAssets } from "../src/gateway/live-dashboard-assets.js";
import {
  createLiveDashboardRequestHandler,
  type LiveDashboardHttpAssets,
  type LiveDashboardRequestHandler,
} from "../src/gateway/live-dashboard-http.js";
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

const DEFAULT_CONTENT_SECURITY_POLICY =
  "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
const SHELL_CONTENT_SECURITY_POLICY =
  "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

const JAVASCRIPT_CONTENT_TYPE = "text/javascript; charset=utf-8";

// Every body carries a multi-byte character so the Content-Length assertions
// prove UTF-8 byte framing rather than UTF-16 code-unit length.
const ASSETS: LiveDashboardHttpAssets = Object.freeze({
  shellHtml: "<!doctype html><title>Embassy — live</title>",
  clientJavaScript: '"use strict";window.EMBASSY_BOOT={locale:"zh-CN"};/* 引导 */\n',
  styleSheet: ":root{--ink:#212121}/* 样式 — tokens */\n",
  appJavaScript: '"use strict";var Embassy;/* 应用 — bundle */\n',
  vendorReactJavaScript: "(function(){'use strict';/* react — vendored */})();\n",
  vendorReactDomJavaScript:
    "(function(){'use strict';/* react-dom — vendored */})();\n",
});

type AssetRoute = Readonly<{
  leaf: string;
  body: string;
  contentType: string;
  contentSecurityPolicy: string;
}>;

const ASSET_ROUTES: readonly AssetRoute[] = Object.freeze([
  {
    leaf: "bootstrap",
    body: ASSETS.shellHtml,
    contentType: "text/html; charset=utf-8",
    contentSecurityPolicy: SHELL_CONTENT_SECURITY_POLICY,
  },
  {
    leaf: "app.css",
    body: ASSETS.styleSheet,
    contentType: "text/css; charset=utf-8",
    contentSecurityPolicy: DEFAULT_CONTENT_SECURITY_POLICY,
  },
  {
    leaf: "react.js",
    body: ASSETS.vendorReactJavaScript,
    contentType: JAVASCRIPT_CONTENT_TYPE,
    contentSecurityPolicy: DEFAULT_CONTENT_SECURITY_POLICY,
  },
  {
    leaf: "react-dom.js",
    body: ASSETS.vendorReactDomJavaScript,
    contentType: JAVASCRIPT_CONTENT_TYPE,
    contentSecurityPolicy: DEFAULT_CONTENT_SECURITY_POLICY,
  },
  {
    leaf: "client.js",
    body: ASSETS.clientJavaScript,
    contentType: JAVASCRIPT_CONTENT_TYPE,
    contentSecurityPolicy: DEFAULT_CONTENT_SECURITY_POLICY,
  },
  {
    leaf: "app.js",
    body: ASSETS.appJavaScript,
    contentType: JAVASCRIPT_CONTENT_TYPE,
    contentSecurityPolicy: DEFAULT_CONTENT_SECURITY_POLICY,
  },
]);

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

  writeHead(statusCode: number, headers: Record<string, string>): this {
    this.statusCode = statusCode;
    Object.assign(this.headers, headers);
    this.headersSent = true;
    return this;
  }

  write(chunk: string | Buffer): boolean {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return true;
  }

  end(chunk?: string | Buffer): this {
    if (chunk !== undefined) this.write(chunk);
    this.writableEnded = true;
    return this;
  }

  bodyText(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }

  bodyBytes(): number {
    return Buffer.concat(this.chunks).length;
  }
}

class SyntheticHub implements LiveDashboardStreamHub {
  writer: LiveDashboardStreamWriter | undefined;

  add(
    writer: LiveDashboardStreamWriter,
  ):
    | Readonly<{ ok: true; close(): void }>
    | Readonly<{ ok: false; safeCode: "LIVE_STREAM_LIMIT" }> {
    this.writer = writer;
    return { ok: true, close: () => undefined };
  }

  latest(): LiveDashboardStreamEvent | undefined {
    return LATEST;
  }

  async pollNow(): Promise<void> {}

  async refresh(): Promise<LiveDashboardStreamEvent | undefined> {
    return LATEST;
  }

  shutdown(): void {}

  streamCount(): number {
    return 0;
  }
}

function createHandler(
  assets: LiveDashboardHttpAssets = ASSETS,
  lang: DashboardLocale = "en",
): LiveDashboardRequestHandler {
  return createLiveDashboardRequestHandler({
    instancePath: INSTANCE_PATH,
    expectedHost: HOST,
    expectedOrigin: ORIGIN,
    capability: CAPABILITY,
    sessionSecret: SESSION_SECRET,
    cookieName: COOKIE_NAME,
    lang,
    assets,
    hub: new SyntheticHub(),
  });
}

function navigationHeaders(additions: readonly string[] = []): string[] {
  return ["Host", HOST, ...additions];
}

async function invoke(
  handler: LiveDashboardRequestHandler,
  input: Readonly<{
    method: string;
    target: string;
    rawHeaders: string[];
    body?: string;
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

function assertSecurityHeaders(
  response: SyntheticResponse,
  contentSecurityPolicy: string,
  label: string,
): void {
  assert.equal(response.headers["Cache-Control"], "no-store", label);
  assert.equal(response.headers.Pragma, "no-cache", label);
  assert.equal(
    response.headers["Content-Security-Policy"],
    contentSecurityPolicy,
    label,
  );
  assert.equal(
    response.headers["Cross-Origin-Opener-Policy"],
    "same-origin",
    label,
  );
  assert.equal(
    response.headers["Cross-Origin-Resource-Policy"],
    "same-origin",
    label,
  );
  assert.equal(
    response.headers["Permissions-Policy"],
    "accelerometer=(), camera=(), geolocation=(), microphone=(), payment=(), usb=()",
    label,
  );
  assert.equal(response.headers["Referrer-Policy"], "no-referrer", label);
  assert.equal(response.headers["X-Content-Type-Options"], "nosniff", label);
  assert.equal(response.headers["X-Frame-Options"], "DENY", label);
  for (const name of Object.keys(response.headers)) {
    assert.doesNotMatch(
      name,
      /^access-control-/iu,
      `${label}: unexpected CORS header ${name}`,
    );
  }
}

test("serves every live dashboard asset route with exact framing and security headers", async () => {
  const handler = createHandler();

  for (const route of ASSET_ROUTES) {
    const response = await invoke(handler, {
      method: "GET",
      target: `${INSTANCE_PATH}/${route.leaf}`,
      rawHeaders: navigationHeaders(),
    });
    assert.equal(response.statusCode, 200, route.leaf);
    assert.equal(response.bodyText(), route.body, route.leaf);
    assert.equal(response.headers["Content-Type"], route.contentType, route.leaf);
    assert.equal(
      response.headers["Content-Length"],
      String(Buffer.byteLength(route.body, "utf8")),
      route.leaf,
    );
    assert.equal(
      response.bodyBytes(),
      Buffer.byteLength(route.body, "utf8"),
      route.leaf,
    );
    assert.equal(response.writableEnded, true, route.leaf);
    assertSecurityHeaders(response, route.contentSecurityPolicy, route.leaf);
  }
});

test("keeps the widened shell CSP exclusive to the bootstrap document", async () => {
  const handler = createHandler();

  const bootstrap = await invoke(handler, {
    method: "GET",
    target: `${INSTANCE_PATH}/bootstrap`,
    rawHeaders: navigationHeaders(),
  });
  assert.equal(
    bootstrap.headers["Content-Security-Policy"],
    SHELL_CONTENT_SECURITY_POLICY,
  );

  for (const route of ASSET_ROUTES.filter((entry) => entry.leaf !== "bootstrap")) {
    const response = await invoke(handler, {
      method: "GET",
      target: `${INSTANCE_PATH}/${route.leaf}`,
      rawHeaders: navigationHeaders(),
    });
    const policy = response.headers["Content-Security-Policy"] ?? "";
    assert.equal(policy, DEFAULT_CONTENT_SECURITY_POLICY, route.leaf);
    for (const directive of ["script-src", "style-src", "connect-src"]) {
      assert.equal(
        policy.includes(directive),
        false,
        `${route.leaf} must not widen ${directive}`,
      );
    }
  }

  // The authenticated data routes keep the default policy too.
  const snapshot = await invoke(handler, {
    method: "POST",
    target: `${INSTANCE_PATH}/snapshot`,
    rawHeaders: [
      "Host",
      HOST,
      "Origin",
      ORIGIN,
      "X-Embassy-Request",
      "1",
      "Cookie",
      `${COOKIE_NAME}=${SESSION_SECRET}`,
    ],
  });
  assert.equal(snapshot.statusCode, 200);
  assert.equal(
    snapshot.headers["Content-Security-Policy"],
    DEFAULT_CONTENT_SECURITY_POLICY,
  );
});

test("rejects every non-GET method on the asset routes with 405", async () => {
  const handler = createHandler();

  for (const route of ASSET_ROUTES) {
    for (const method of ["POST", "OPTIONS", "HEAD", "PUT", "DELETE", "PATCH"]) {
      const response = await invoke(handler, {
        method,
        target: `${INSTANCE_PATH}/${route.leaf}`,
        rawHeaders: navigationHeaders([
          "Origin",
          ORIGIN,
          "X-Embassy-Request",
          "1",
        ]),
      });
      assert.equal(
        response.statusCode,
        405,
        `${method} ${route.leaf} must be method-not-allowed`,
      );
      assert.equal(
        response.bodyText().includes(route.body),
        false,
        `${method} ${route.leaf} must not leak the asset`,
      );
      assertSecurityHeaders(
        response,
        DEFAULT_CONTENT_SECURITY_POLICY,
        `${method} ${route.leaf}`,
      );
    }
  }
});

test("rejects cross-origin, unknown, and malformed asset targets", async () => {
  const handler = createHandler();

  for (const route of ASSET_ROUTES) {
    const wrongHost = await invoke(handler, {
      method: "GET",
      target: `${INSTANCE_PATH}/${route.leaf}`,
      rawHeaders: ["Host", "localhost:43127"],
    });
    assert.equal(wrongHost.statusCode, 403, `${route.leaf} wrong Host`);
    assert.equal(wrongHost.bodyText().includes(route.body), false);
    assertSecurityHeaders(
      wrongHost,
      DEFAULT_CONTENT_SECURITY_POLICY,
      `${route.leaf} wrong Host`,
    );

    const crossOrigin = await invoke(handler, {
      method: "GET",
      target: `${INSTANCE_PATH}/${route.leaf}`,
      rawHeaders: navigationHeaders(["Origin", "http://localhost:43127"]),
    });
    assert.equal(crossOrigin.statusCode, 403, `${route.leaf} foreign Origin`);

    const duplicateHost = await invoke(handler, {
      method: "GET",
      target: `${INSTANCE_PATH}/${route.leaf}`,
      rawHeaders: ["Host", HOST, "Host", HOST],
    });
    assert.equal(duplicateHost.statusCode, 400, `${route.leaf} duplicate Host`);
  }

  for (const target of [
    `${INSTANCE_PATH}/react.js/`,
    `${INSTANCE_PATH}/react.js?v=1`,
    `${INSTANCE_PATH}/react-dom.js.map`,
    `${INSTANCE_PATH}/app.js.map`,
    `${INSTANCE_PATH}/App.js`,
    `${INSTANCE_PATH}/vendor/react.js`,
    `${INSTANCE_PATH}/live-dashboard-app/app.js`,
    `${INSTANCE_PATH}/favicon.ico`,
    "/react.js",
    "/app.js",
  ]) {
    const response = await invoke(handler, {
      method: "GET",
      target,
      rawHeaders: navigationHeaders(),
    });
    assert.equal(response.statusCode, 404, `${target} must be 404`);
    assertSecurityHeaders(response, DEFAULT_CONTENT_SECURITY_POLICY, target);
  }

  for (const target of [
    `${INSTANCE_PATH}/app.js#fragment`,
    `//${INSTANCE_PATH}/app.js`,
  ]) {
    const response = await invoke(handler, {
      method: "GET",
      target,
      rawHeaders: navigationHeaders(),
    });
    assert.equal(response.statusCode, 400, `${target} must be 400`);
  }
});

test("serves the rendered shell and bundles byte-for-byte in both locales", async () => {
  for (const locale of ["en", "zh-CN"] as const) {
    const assets = renderLiveDashboardAssets(locale);
    const handler = createHandler(assets, locale);
    const fixtures: ReadonlyArray<readonly [string, string, string]> = [
      ["bootstrap", assets.shellHtml, "text/html; charset=utf-8"],
      ["app.css", assets.styleSheet, "text/css; charset=utf-8"],
      ["react.js", assets.vendorReactJavaScript, JAVASCRIPT_CONTENT_TYPE],
      ["react-dom.js", assets.vendorReactDomJavaScript, JAVASCRIPT_CONTENT_TYPE],
      ["client.js", assets.clientJavaScript, JAVASCRIPT_CONTENT_TYPE],
      ["app.js", assets.appJavaScript, JAVASCRIPT_CONTENT_TYPE],
    ];

    for (const [leaf, body, contentType] of fixtures) {
      const response = await invoke(handler, {
        method: "GET",
        target: `${INSTANCE_PATH}/${leaf}`,
        rawHeaders: navigationHeaders(),
      });
      const label = `${locale} ${leaf}`;
      assert.equal(response.statusCode, 200, label);
      assert.equal(response.headers["Content-Type"], contentType, label);
      assert.equal(
        response.headers["Content-Length"],
        String(Buffer.byteLength(body, "utf8")),
        label,
      );
      assert.equal(response.bodyText(), body, label);
      assert.ok(body.length > 0, `${label} must not be empty`);
    }
  }
});

test("renders a shell of relative hrefs, ordered classic scripts, and no inline code", () => {
  for (const locale of ["en", "zh-CN"] as const) {
    const shell = renderLiveDashboardAssets(locale).shellHtml;
    const label = `${locale} shell`;

    assert.ok(shell.startsWith("<!doctype html>"), label);
    assert.ok(shell.includes(`<html lang="${locale}">`), label);
    assert.ok(shell.includes('<meta name="referrer" content="no-referrer">'), label);
    assert.ok(shell.includes('<div id="root"'), label);
    assert.ok(shell.includes("<noscript>"), label);
    assert.ok(shell.includes('<link rel="stylesheet" href="app.css">'), label);

    // Relative hrefs only: the instance path must never appear in the HTML.
    assert.equal(shell.includes(INSTANCE_PATH), false, `${label} instance path`);
    for (const forbidden of [
      "http://",
      "https://",
      'src="/',
      'href="/',
      'src="//',
      'href="//',
      "javascript:",
      "data:",
      "<style",
      'style="',
      'type="module"',
      "integrity=",
      "crossorigin",
    ]) {
      assert.equal(
        shell.includes(forbidden),
        false,
        `${label} must not contain ${forbidden}`,
      );
    }
    assert.doesNotMatch(shell, /\son[a-z]+\s*=/iu, `${label} inline handler`);

    const scripts = [...shell.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gu)];
    assert.equal(scripts.length, 4, `${label} script count`);
    const sources = scripts.map((match) => {
      const attributes = match[1] ?? "";
      const inner = match[2] ?? "";
      assert.equal(inner, "", `${label} script bodies must be empty`);
      assert.match(attributes, /\sdefer\b/u, `${label} scripts must defer`);
      const source = /\ssrc="([^"]+)"/u.exec(attributes)?.[1];
      assert.ok(source !== undefined, `${label} script needs a src`);
      assert.doesNotMatch(source, /^[a-z]+:|^\/\/|^\//iu, `${label} relative src`);
      return source;
    });
    assert.deepEqual(
      sources,
      ["react.js", "react-dom.js", "client.js", "app.js"],
      `${label} load order: react before react-dom before boot before app`,
    );
  }
});

test("every asset the shell references resolves to a served route", async () => {
  const assets = renderLiveDashboardAssets("en");
  const handler = createHandler(assets, "en");
  const references = [
    ...assets.shellHtml.matchAll(/(?:src|href)="([^"]+)"/gu),
  ].map((match) => match[1] ?? "");
  assert.equal(references.length, 5, "one stylesheet plus four scripts");

  for (const reference of references) {
    const response = await invoke(handler, {
      method: "GET",
      target: `${INSTANCE_PATH}/${reference}`,
      rawHeaders: navigationHeaders(),
    });
    assert.equal(response.statusCode, 200, `${reference} must resolve`);
  }
});
