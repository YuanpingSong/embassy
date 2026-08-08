import type { IncomingMessage, ServerResponse } from "node:http";

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
}>;

export type LiveDashboardRequestHandler = (
  request: IncomingMessage,
  response: ServerResponse,
) => Promise<void>;

export type LiveDashboardRequestHandlerOptions = Readonly<{
  instancePath: string;
  expectedHost: string;
  expectedOrigin: string;
  capability: string;
  sessionSecret: string;
  cookieName: string;
  assets: LiveDashboardHttpAssets;
  hub: LiveDashboardStreamHub;
}>;

type Route = Readonly<{
  kind: LiveDashboardRequestKind;
  name: "bootstrap" | "client" | "session" | "snapshot" | "stream" | "style";
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
    case `${instancePath}/session`:
      return { kind: "session", name: "session" };
    case `${instancePath}/snapshot`:
      return { kind: "authenticated", name: "snapshot" };
    case `${instancePath}/stream`:
      return { kind: "authenticated", name: "stream" };
    default:
      return undefined;
  }
}

function statusBody(statusCode: number): string {
  switch (statusCode) {
    case 400:
      return "Bad request.\n";
    case 403:
      return "Forbidden.\n";
    case 404:
      return "Not found.\n";
    case 405:
      return "Method not allowed.\n";
    case 413:
      return "Request body too large.\n";
    case 414:
      return "Request target too large.\n";
    case 415:
      return "Unsupported media type.\n";
    case 429:
      return "Too many live streams.\n";
    case 431:
      return "Request headers too large.\n";
    case 503:
      return "Dashboard snapshot unavailable.\n";
    default:
      return "Request failed.\n";
  }
}

function respond(
  response: ServerResponse,
  statusCode: number,
  body = statusBody(statusCode),
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
    assets,
    cookieName,
    expectedHost,
    expectedOrigin,
    hub,
    instancePath,
    sessionSecret,
  } = options;
  const cookieHeader = sessionCookieHeader(
    cookieName,
    sessionSecret,
    instancePath,
  );
  let remainingCapability: string | undefined = options.capability;

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
        respond(response, validation.statusCode);
        return;
      }
      if (route === undefined) {
        respond(response, 404);
        return;
      }

      switch (route.name) {
        case "bootstrap":
          respond(
            response,
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
            200,
            assets.clientJavaScript,
            "text/javascript; charset=utf-8",
          );
          return;
        case "style":
          respond(
            response,
            200,
            assets.styleSheet,
            "text/css; charset=utf-8",
          );
          return;
        case "session": {
          const contentType = validation.headers.get("content-type");
          if (
            contentType !== "text/plain" &&
            contentType !== "text/plain;charset=UTF-8"
          ) {
            respond(response, 415);
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
            respond(response, 400);
            return;
          }
          if (contentLength > LIVE_DASHBOARD_LIMITS.maximumSessionBodyBytes) {
            respond(response, 413);
            return;
          }
          const body = await readBoundedBody(
            request,
            contentLength,
            LIVE_DASHBOARD_LIMITS.maximumSessionBodyBytes,
          );
          if (!body.ok) {
            respond(response, body.statusCode);
            return;
          }
          if (!equalSecret(body.body, remainingCapability)) {
            respond(response, 403);
            return;
          }
          remainingCapability = undefined;
          respondWithoutBody(response, 204, { "Set-Cookie": cookieHeader });
          return;
        }
        case "snapshot": {
          const bodyError = validateEmptyPostBody(validation);
          if (bodyError !== undefined) {
            respond(response, bodyError);
            return;
          }
          if (!authenticated(validation, cookieName, sessionSecret)) {
            respond(response, 403);
            return;
          }
          const refreshed = await hub.refresh();
          if (refreshed === undefined) {
            respond(response, 503);
            return;
          }
          respond(
            response,
            200,
            JSON.stringify(refreshed),
            "application/json; charset=utf-8",
          );
          return;
        }
        case "stream": {
          const bodyError = validateEmptyPostBody(validation);
          if (bodyError !== undefined) {
            respond(response, bodyError);
            return;
          }
          if (!authenticated(validation, cookieName, sessionSecret)) {
            respond(response, 403);
            return;
          }
          if (hub.streamCount() >= LIVE_DASHBOARD_LIMITS.maximumStreams) {
            respond(response, 429);
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
      }
    } catch {
      if (!response.headersSent) {
        respond(response, 500);
      } else if (!response.writableEnded) {
        response.end();
      }
    }
  };
}
