import type { IncomingMessage, ServerResponse } from "node:http";

import { isGatewayAlias, type GatewayDecisionCode } from "./control.js";
import {
  assertDashboardLocale,
  getDashboardCopy,
  type DashboardCopy,
  type DashboardLocale,
} from "./dashboard-copy.js";
import {
  LIVE_DASHBOARD_LIMITS,
  liveDashboardSecurityHeaders,
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
  | Readonly<{
      action: "pair" | "unpair";
      claudeAlias: string;
      codexAlias: string;
    }>
  | Readonly<{
      action: "remove_stale_codex_registration";
      alias: string;
    }>
  | Readonly<{ action: "refresh_dashboard" }>;

export type LiveDashboardActionResult = Readonly<{
  ok: boolean;
  code: GatewayDecisionCode | "rate_limited" | "unavailable";
}>;

export type LiveDashboardActionExecutor = Readonly<{
  execute(action: LiveDashboardAction): Promise<LiveDashboardActionResult>;
}>;

export type LiveDashboardRequestHandlerOptions = Readonly<{
  expectedHost: string;
  expectedOrigin: string;
  lang: DashboardLocale;
  assets: LiveDashboardHttpAssets;
  hub: LiveDashboardStreamHub;
  actions: LiveDashboardActionExecutor;
  now?: () => number;
}>;

type Route = Readonly<{
  kind: LiveDashboardRequestKind;
  name:
    | "shell"
    | "client"
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

function assertOptions(options: LiveDashboardRequestHandlerOptions): void {
  assertDashboardLocale(options.lang);
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
}

function routeFor(target: string | undefined): Route | undefined {
  switch (target) {
    case "/":
      return { kind: "navigation", name: "shell" };
    case "/client.js":
      return { kind: "navigation", name: "client" };
    case "/app.css":
      return { kind: "navigation", name: "style" };
    case "/react.js":
      return { kind: "navigation", name: "vendorReact" };
    case "/react-dom.js":
      return { kind: "navigation", name: "vendorReactDom" };
    case "/app.js":
      return { kind: "navigation", name: "app" };
    case "/snapshot":
      return { kind: "api", name: "snapshot" };
    case "/stream":
      return { kind: "api", name: "stream" };
    case "/action":
      return { kind: "api", name: "action" };
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
    record.action === "remove_stale_codex_registration" &&
    keys.length === 2 &&
    keys.includes("action") &&
    keys.includes("alias") &&
    typeof record.alias === "string" &&
    record.alias.length <= 128 &&
    isGatewayAlias(record.alias) &&
    record.alias.startsWith("codex-")
  ) {
    return {
      action: "remove_stale_codex_registration",
      alias: record.alias,
    };
  }
  if (
    (record.action === "pair" || record.action === "unpair") &&
    keys.length === 3 &&
    keys.includes("action") &&
    keys.includes("claudeAlias") &&
    keys.includes("codexAlias") &&
    typeof record.claudeAlias === "string" &&
    typeof record.codexAlias === "string" &&
    record.claudeAlias.length <= 128 &&
    record.codexAlias.length <= 128 &&
    isGatewayAlias(record.claudeAlias) &&
    isGatewayAlias(record.codexAlias) &&
    record.claudeAlias.startsWith("claude-") &&
    record.codexAlias.startsWith("codex-") &&
    record.claudeAlias.slice(record.claudeAlias.lastIndexOf("@") + 1) ===
      record.codexAlias.slice(record.codexAlias.lastIndexOf("@") + 1)
  ) {
    return {
      action: record.action,
      claudeAlias: record.claudeAlias,
      codexAlias: record.codexAlias,
    };
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
    expectedHost,
    expectedOrigin,
    hub,
    lang,
  } = options;
  const now = options.now ?? Date.now;
  const copy = getDashboardCopy(lang);
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
      const route = routeFor(request.url);
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
            (request.method === "GET" ? "navigation" : "api"),
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
        case "shell":
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
        case "snapshot": {
          const bodyError = validateEmptyPostBody(validation);
          if (bodyError !== undefined) {
            respond(response, copy, bodyError);
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
