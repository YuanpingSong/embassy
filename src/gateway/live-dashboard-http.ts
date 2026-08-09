import type { IncomingMessage, ServerResponse } from "node:http";

import { isGatewayAlias, type GatewayDecisionCode } from "./control.js";
import {
  assertDashboardLocale,
  getDashboardCopy,
  type DashboardCopy,
  type DashboardLocale,
} from "./dashboard-copy.js";
import {
  equalSecret,
  LIVE_DASHBOARD_LIMITS,
  liveDashboardSecurityHeaders,
  readSingleCookie,
  sessionCookieHeader,
  validateLiveDashboardRequest,
  type LiveDashboardRequestKind,
  type LiveDashboardRequestValidation,
} from "./live-dashboard-protocol.js";
import type {
  LiveDashboardStreamHub,
  LiveDashboardStreamWriter,
} from "./live-dashboard-stream.js";

export type LiveDashboardHttpAssets = Readonly<{
  shellHtml: string;
  clientJavaScript: string;
  styleSheet: string;
  appJavaScript: string;
  vendorReactJavaScript: string;
  vendorReactDomJavaScript: string;
}>;

export type LiveDashboardRequestHandler = (
  request: IncomingMessage,
  response: ServerResponse,
) => Promise<void>;

export type LiveDashboardAction =
  | Readonly<{ action: "select_claude"; alias: string }>
  | Readonly<{ action: "unselect_claude"; alias: string }>
  | Readonly<{ action: "refresh_dashboard" }>;

export type LiveDashboardActionResult = Readonly<{
  ok: boolean;
  code: GatewayDecisionCode | "rate_limited" | "unavailable";
}>;

export type LiveDashboardActionExecutor = Readonly<{
  execute(action: LiveDashboardAction): Promise<LiveDashboardActionResult>;
}>;

export type LiveDashboardRequestHandlerOptions = Readonly<{
  instancePath: string;
  expectedHost: string;
  expectedOrigin: string;
  capability: string;
  sessionSecret: string;
  cookieName: string;
  lang: DashboardLocale;
  assets: LiveDashboardHttpAssets;
  hub: LiveDashboardStreamHub;
  actions: LiveDashboardActionExecutor;
  now?: () => number;
}>;

type Route = Readonly<{
  kind: LiveDashboardRequestKind;
  name:
    | "bootstrap"
    | "client"
    | "session"
    | "snapshot"
    | "stream"
    | "action"
    | "style"
    | "vendorReact"
    | "vendorReactDom"
    | "app";
}>;

type BodyReadResult =
  | Readonly<{ ok: true; body: string }>
  | Readonly<{ ok: false; statusCode: 400 | 413 }>;

const SHELL_CONTENT_SECURITY_POLICY =
  "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

function isCanonical256BitBase64Url(value: string): boolean {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(value)) return false;
  const decoded = Buffer.from(value, "base64url");
  return decoded.length === 32 && decoded.toString("base64url") === value;
}

function assertOptions(options: LiveDashboardRequestHandlerOptions): void {
  assertDashboardLocale(options.lang);
  if (!/^\/[A-Za-z0-9_-]{16,128}$/u.test(options.instancePath)) {
    throw new Error("LIVE_DASHBOARD_INSTANCE_PATH_INVALID");
  }
  const hostMatch = /^127\.0\.0\.1:([1-9][0-9]{0,4})$/u.exec(
    options.expectedHost,
  );
  const port = Number(hostMatch?.[1]);
  if (
    hostMatch === null ||
    !Number.isInteger(port) ||
    port > 65_535 ||
    options.expectedOrigin !== `http://${options.expectedHost}`
  ) {
    throw new Error("LIVE_DASHBOARD_ORIGIN_INVALID");
  }
  if (!isCanonical256BitBase64Url(options.capability)) {
    throw new Error("LIVE_DASHBOARD_CAPABILITY_INVALID");
  }
  if (!isCanonical256BitBase64Url(options.sessionSecret)) {
    throw new Error("LIVE_DASHBOARD_SESSION_SECRET_INVALID");
  }
}

function routeFor(target: string | undefined, instancePath: string): Route | undefined {
  switch (target) {
    case `${instancePath}/bootstrap`:
      return { kind: "navigation", name: "bootstrap" };
    case `${instancePath}/client.js`:
      return { kind: "navigation", name: "client" };
    case `${instancePath}/app.css`:
      return { kind: "navigation", name: "style" };
    case `${instancePath}/react.js`:
      return { kind: "navigation", name: "vendorReact" };
    case `${instancePath}/react-dom.js`:
      return { kind: "navigation", name: "vendorReactDom" };
    case `${instancePath}/app.js`:
      return { kind: "navigation", name: "app" };
    case `${instancePath}/session`:
      return { kind: "session", name: "session" };
    case `${instancePath}/snapshot`:
      return { kind: "authenticated", name: "snapshot" };
    case `${instancePath}/stream`:
      return { kind: "authenticated", name: "stream" };
    case `${instancePath}/action`:
      return { kind: "authenticated", name: "action" };
    default:
      return undefined;
  }
}

function statusBody(copy: DashboardCopy, statusCode: number): string {
  switch (statusCode) {
    case 400:
      return `${copy["live.http.badRequest"]}\n`;
    case 403:
      return `${copy["live.http.forbidden"]}\n`;
    case 404:
      return `${copy["live.http.notFound"]}\n`;
    case 405:
      return `${copy["live.http.methodNotAllowed"]}\n`;
    case 413:
      return `${copy["live.http.bodyTooLarge"]}\n`;
    case 414:
      return `${copy["live.http.targetTooLarge"]}\n`;
    case 415:
      return `${copy["live.http.unsupportedMediaType"]}\n`;
    case 429:
      return `${copy["live.http.tooManyStreams"]}\n`;
    case 431:
      return `${copy["live.http.headersTooLarge"]}\n`;
    case 503:
      return `${copy["live.http.snapshotUnavailable"]}\n`;
    default:
      return `${copy["live.http.requestFailed"]}\n`;
  }
}

function respond(
  response: ServerResponse,
  copy: DashboardCopy,
  statusCode: number,
  body = statusBody(copy, statusCode),
  contentType = "text/plain; charset=utf-8",
  additionalHeaders: Readonly<Record<string, string>> = {},
  contentSecurityPolicy?: string,
): void {
  const encoded = Buffer.from(body, "utf8");
  response.writeHead(statusCode, {
    ...liveDashboardSecurityHeaders(contentSecurityPolicy),
    "Content-Type": contentType,
    "Content-Length": String(encoded.length),
    ...additionalHeaders,
  });
  response.end(encoded);
}

function respondWithoutBody(
  response: ServerResponse,
  statusCode: number,
  additionalHeaders: Readonly<Record<string, string>> = {},
): void {
  response.writeHead(statusCode, {
    ...liveDashboardSecurityHeaders(),
    "Content-Length": "0",
    ...additionalHeaders,
  });
  response.end();
}

function parseContentLength(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) return Number.NaN;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : Number.NaN;
}

function readBoundedBody(
  request: IncomingMessage,
  declaredLength: number,
  maximumBytes: number,
): Promise<BodyReadResult> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let received = 0;
    let tooLarge = false;
    let settled = false;

    const cleanup = (): void => {
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("error", onFailure);
      request.off("aborted", onFailure);
    };
    const finish = (result: BodyReadResult): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    const onData = (chunk: Buffer | Uint8Array | string): void => {
      let bytes: Buffer;
      if (typeof chunk === "string") {
        bytes = Buffer.from(chunk, "utf8");
      } else if (Buffer.isBuffer(chunk) || chunk instanceof Uint8Array) {
        bytes = Buffer.from(chunk);
      } else {
        tooLarge = true;
        return;
      }
      received += bytes.length;
      if (received > maximumBytes) {
        tooLarge = true;
        return;
      }
      if (!tooLarge) chunks.push(bytes);
    };
    const onEnd = (): void => {
      if (tooLarge) {
        finish({ ok: false, statusCode: 413 });
        return;
      }
      if (received !== declaredLength) {
        finish({ ok: false, statusCode: 400 });
        return;
      }
      finish({ ok: true, body: Buffer.concat(chunks).toString("utf8") });
    };
    const onFailure = (): void => finish({ ok: false, statusCode: 400 });

    request.on("data", onData);
    request.once("end", onEnd);
    request.once("error", onFailure);
    request.once("aborted", onFailure);
  });
}

function validateEmptyPostBody(
  validation: Extract<LiveDashboardRequestValidation, { ok: true }>,
): 400 | undefined {
  const contentLength = parseContentLength(
    validation.headers.get("content-length"),
  );
  if (
    (contentLength !== undefined && !Number.isFinite(contentLength)) ||
    (contentLength !== undefined && contentLength !== 0)
  ) {
    return 400;
  }
  return undefined;
}

function authenticated(
  validation: Extract<LiveDashboardRequestValidation, { ok: true }>,
  cookieName: string,
  sessionSecret: string,
): boolean {
  const supplied = readSingleCookie(
    validation.headers.get("cookie"),
    cookieName,
  );
  return equalSecret(supplied, sessionSecret);
}

function parseAction(body: string): LiveDashboardAction | undefined {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Readonly<Record<string, unknown>>;
  const keys = Object.keys(record);
  if (
    record.action === "refresh_dashboard" &&
    keys.length === 1 &&
    keys[0] === "action"
  ) {
    return { action: "refresh_dashboard" };
  }
  if (
    (record.action === "select_claude" ||
      record.action === "unselect_claude") &&
    keys.length === 2 &&
    keys.includes("action") &&
    keys.includes("alias") &&
    typeof record.alias === "string" &&
    record.alias.length <= 128 &&
    isGatewayAlias(record.alias)
  ) {
    return { action: record.action, alias: record.alias };
  }
  return undefined;
}

function isActionResult(value: unknown): value is LiveDashboardActionResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Readonly<Record<string, unknown>>;
  const validShape =
    Object.keys(record).length === 2 &&
    typeof record.ok === "boolean" &&
    typeof record.code === "string" &&
    /^(?:ok|not_found|conflict|route_mismatch|busy|unavailable|rejected)$/u.test(
      record.code,
    );
  return (
    validShape &&
    ((record.ok === true && record.code === "ok") ||
      (record.ok === false && record.code !== "ok"))
  );
}

function actionResponse(
  response: ServerResponse,
  copy: DashboardCopy,
  statusCode: 200 | 429 | 503,
  result: LiveDashboardActionResult,
  additionalHeaders: Readonly<Record<string, string>> = {},
): void {
  respond(
    response,
    copy,
    statusCode,
    JSON.stringify(result),
    "application/json; charset=utf-8",
    additionalHeaders,
  );
}

function streamWriter(response: ServerResponse): LiveDashboardStreamWriter {
  return {
    write: (chunk) => response.write(chunk),
    onDrain: (callback) => {
      response.on("drain", callback);
    },
    onClose: (callback) => {
      response.once("close", callback);
      response.once("error", callback);
    },
    end: () => {
      response.end();
    },
  };
}

export function createLiveDashboardRequestHandler(
  options: LiveDashboardRequestHandlerOptions,
): LiveDashboardRequestHandler {
  assertOptions(options);
  const {
    actions,
    assets,
    cookieName,
    expectedHost,
    expectedOrigin,
    hub,
    instancePath,
    lang,
    sessionSecret,
  } = options;
  const now = options.now ?? Date.now;
  const copy = getDashboardCopy(lang);
  const cookieHeader = sessionCookieHeader(
    cookieName,
    sessionSecret,
    instancePath,
  );
  let remainingCapability: string | undefined = options.capability;
  let actionTokens: number = LIVE_DASHBOARD_LIMITS.maximumActionsPerMinute;
  let actionRefilledAt = now();

  const consumeActionToken = (): number | undefined => {
    const observedAt = now();
    const elapsed = Math.max(0, observedAt - actionRefilledAt);
    actionRefilledAt = Math.max(actionRefilledAt, observedAt);
    actionTokens = Math.min(
      LIVE_DASHBOARD_LIMITS.maximumActionsPerMinute,
      actionTokens +
        (elapsed * LIVE_DASHBOARD_LIMITS.maximumActionsPerMinute) / 60_000,
    );
    if (actionTokens >= 1) {
      actionTokens -= 1;
      return undefined;
    }
    return Math.max(
      1,
      Math.ceil(
        ((1 - actionTokens) * 60) /
          LIVE_DASHBOARD_LIMITS.maximumActionsPerMinute,
      ),
    );
  };

  return async (request, response) => {
    try {
      const route = routeFor(request.url, instancePath);
      const validation = validateLiveDashboardRequest(
        {
          method: request.method,
          target: request.url,
          rawHeaders: request.rawHeaders,
        },
        {
          expectedHost,
          expectedOrigin,
          kind:
            route?.kind ??
            (request.method === "GET" ? "navigation" : "authenticated"),
        },
      );
      if (!validation.ok) {
        respond(response, copy, validation.statusCode);
        return;
      }
      if (route === undefined) {
        respond(response, copy, 404);
        return;
      }

      switch (route.name) {
        case "bootstrap":
          respond(
            response,
            copy,
            200,
            assets.shellHtml,
            "text/html; charset=utf-8",
            {},
            SHELL_CONTENT_SECURITY_POLICY,
          );
          return;
        case "client":
          respond(
            response,
            copy,
            200,
            assets.clientJavaScript,
            "text/javascript; charset=utf-8",
          );
          return;
        case "style":
          respond(
            response,
            copy,
            200,
            assets.styleSheet,
            "text/css; charset=utf-8",
          );
          return;
        case "vendorReact":
          respond(
            response,
            copy,
            200,
            assets.vendorReactJavaScript,
            "text/javascript; charset=utf-8",
          );
          return;
        case "vendorReactDom":
          respond(
            response,
            copy,
            200,
            assets.vendorReactDomJavaScript,
            "text/javascript; charset=utf-8",
          );
          return;
        case "app":
          respond(
            response,
            copy,
            200,
            assets.appJavaScript,
            "text/javascript; charset=utf-8",
          );
          return;
        case "session": {
          const contentType = validation.headers.get("content-type");
          if (
            contentType !== "text/plain" &&
            contentType !== "text/plain;charset=UTF-8"
          ) {
            respond(response, copy, 415);
            return;
          }
          const contentLength = parseContentLength(
            validation.headers.get("content-length"),
          );
          if (
            contentLength === undefined ||
            !Number.isFinite(contentLength) ||
            contentLength < 0
          ) {
            respond(response, copy, 400);
            return;
          }
          if (contentLength > LIVE_DASHBOARD_LIMITS.maximumSessionBodyBytes) {
            respond(response, copy, 413);
            return;
          }
          const body = await readBoundedBody(
            request,
            contentLength,
            LIVE_DASHBOARD_LIMITS.maximumSessionBodyBytes,
          );
          if (!body.ok) {
            respond(response, copy, body.statusCode);
            return;
          }
          if (!equalSecret(body.body, remainingCapability)) {
            respond(response, copy, 403);
            return;
          }
          remainingCapability = undefined;
          respondWithoutBody(response, 204, { "Set-Cookie": cookieHeader });
          return;
        }
        case "snapshot": {
          const bodyError = validateEmptyPostBody(validation);
          if (bodyError !== undefined) {
            respond(response, copy, bodyError);
            return;
          }
          if (!authenticated(validation, cookieName, sessionSecret)) {
            respond(response, copy, 403);
            return;
          }
          const refreshed = await hub.refresh();
          if (refreshed === undefined) {
            respond(response, copy, 503);
            return;
          }
          respond(
            response,
            copy,
            200,
            JSON.stringify(refreshed),
            "application/json; charset=utf-8",
          );
          return;
        }
        case "stream": {
          const bodyError = validateEmptyPostBody(validation);
          if (bodyError !== undefined) {
            respond(response, copy, bodyError);
            return;
          }
          if (!authenticated(validation, cookieName, sessionSecret)) {
            respond(response, copy, 403);
            return;
          }
          if (hub.streamCount() >= LIVE_DASHBOARD_LIMITS.maximumStreams) {
            respond(response, copy, 429);
            return;
          }
          response.writeHead(200, {
            ...liveDashboardSecurityHeaders(),
            "Content-Type": "text/event-stream; charset=utf-8",
            Connection: "keep-alive",
          });
          const added = hub.add(streamWriter(response));
          if (!added.ok) response.end();
          return;
        }
        case "action": {
          if (!authenticated(validation, cookieName, sessionSecret)) {
            respond(response, copy, 403);
            return;
          }
          if (validation.headers.get("content-type") !== "application/json") {
            respond(response, copy, 415);
            return;
          }
          const contentLength = parseContentLength(
            validation.headers.get("content-length"),
          );
          if (
            contentLength === undefined ||
            !Number.isFinite(contentLength) ||
            contentLength < 1
          ) {
            respond(response, copy, 400);
            return;
          }
          if (contentLength > LIVE_DASHBOARD_LIMITS.maximumActionBodyBytes) {
            respond(response, copy, 413);
            return;
          }
          const body = await readBoundedBody(
            request,
            contentLength,
            LIVE_DASHBOARD_LIMITS.maximumActionBodyBytes,
          );
          if (!body.ok) {
            respond(response, copy, body.statusCode);
            return;
          }
          const action = parseAction(body.body);
          if (action === undefined) {
            respond(response, copy, 400);
            return;
          }
          const retryAfter = consumeActionToken();
          if (retryAfter !== undefined) {
            actionResponse(
              response,
              copy,
              429,
              { ok: false, code: "rate_limited" },
              { "Retry-After": String(retryAfter) },
            );
            return;
          }
          let result: LiveDashboardActionResult;
          try {
            const executed = await actions.execute(action);
            result = isActionResult(executed)
              ? executed
              : { ok: false, code: "unavailable" };
          } catch {
            result = { ok: false, code: "unavailable" };
          }
          actionResponse(
            response,
            copy,
            result.code === "unavailable" ? 503 : 200,
            result,
          );
          return;
        }
      }
    } catch {
      if (!response.headersSent) {
        respond(response, copy, 500);
      } else if (!response.writableEnded) {
        response.end();
      }
    }
  };
}
