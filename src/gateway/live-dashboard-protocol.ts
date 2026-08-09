import { timingSafeEqual } from "node:crypto";

export const LIVE_DASHBOARD_LIMITS = Object.freeze({
  maximumHeaderBytes: 8 * 1024,
  maximumRequestTargetBytes: 2 * 1024,
  maximumConnections: 16,
  maximumStreams: 4,
  maximumSessionBodyBytes: 256,
  maximumActionBodyBytes: 1_024,
  maximumActionsPerMinute: 6,
  pollIntervalMs: 1_000,
  backpressureTimeoutMs: 5_000,
  heartbeatIntervalMs: 15_000,
  headersTimeoutMs: 5_000,
  requestTimeoutMs: 10_000,
  keepAliveTimeoutMs: 5_000,
} as const);

export type LiveDashboardRequestKind =
  | "navigation"
  | "session"
  | "authenticated";

export type LiveDashboardRequestMetadata = Readonly<{
  method: string | undefined;
  target: string | undefined;
  rawHeaders: readonly string[];
}>;

export type LiveDashboardRequestValidation =
  | Readonly<{
      ok: true;
      headers: ReadonlyMap<string, string>;
    }>
  | Readonly<{
      ok: false;
      statusCode: 400 | 403 | 405 | 414 | 431;
      safeCode:
        | "BAD_REQUEST"
        | "CROSS_ORIGIN_REQUEST"
        | "HEADER_TOO_LARGE"
        | "METHOD_NOT_ALLOWED"
        | "TARGET_TOO_LARGE";
    }>;

const SENSITIVE_SINGLETON_HEADERS = new Set([
  "host",
  "origin",
  "cookie",
  "x-embassy-request",
  "content-length",
  "content-type",
  "transfer-encoding",
]);

const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

function rejected(
  statusCode: 400 | 403 | 405 | 414 | 431,
  safeCode:
    | "BAD_REQUEST"
    | "CROSS_ORIGIN_REQUEST"
    | "HEADER_TOO_LARGE"
    | "METHOD_NOT_ALLOWED"
    | "TARGET_TOO_LARGE",
): LiveDashboardRequestValidation {
  return { ok: false, statusCode, safeCode };
}

function requestHeaderBytes(rawHeaders: readonly string[]): number {
  let bytes = 2;
  for (let index = 0; index < rawHeaders.length; index += 2) {
    bytes += Buffer.byteLength(rawHeaders[index] ?? "", "utf8");
    bytes += 2;
    bytes += Buffer.byteLength(rawHeaders[index + 1] ?? "", "utf8");
    bytes += 2;
  }
  return bytes;
}

function isForwardingHeader(name: string): boolean {
  return name === "forwarded" || name.startsWith("x-forwarded-");
}

export function validateLiveDashboardRequest(
  request: LiveDashboardRequestMetadata,
  options: Readonly<{
    expectedHost: string;
    expectedOrigin: string;
    kind: LiveDashboardRequestKind;
  }>,
): LiveDashboardRequestValidation {
  if (
    request.rawHeaders.length % 2 !== 0 ||
    requestHeaderBytes(request.rawHeaders) >
      LIVE_DASHBOARD_LIMITS.maximumHeaderBytes
  ) {
    return rejected(431, "HEADER_TOO_LARGE");
  }

  const target = request.target;
  if (
    target === undefined ||
    Buffer.byteLength(target, "utf8") >
      LIVE_DASHBOARD_LIMITS.maximumRequestTargetBytes
  ) {
    return rejected(414, "TARGET_TOO_LARGE");
  }
  if (
    !target.startsWith("/") ||
    target.startsWith("//") ||
    target.includes("#") ||
    /[\u0000-\u0020\u007f]/u.test(target)
  ) {
    return rejected(400, "BAD_REQUEST");
  }

  if (request.method === "OPTIONS") {
    return rejected(405, "METHOD_NOT_ALLOWED");
  }
  const requiredMethod = options.kind === "navigation" ? "GET" : "POST";
  if (request.method !== requiredMethod) {
    return rejected(405, "METHOD_NOT_ALLOWED");
  }

  const headers = new Map<string, string>();
  const counts = new Map<string, number>();
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    const rawName = request.rawHeaders[index] ?? "";
    const value = request.rawHeaders[index + 1] ?? "";
    if (!HEADER_NAME_PATTERN.test(rawName) || /[\r\n\u0000]/u.test(value)) {
      return rejected(400, "BAD_REQUEST");
    }
    const name = rawName.toLowerCase();
    if (isForwardingHeader(name) || name === "transfer-encoding") {
      return rejected(400, "BAD_REQUEST");
    }
    const count = (counts.get(name) ?? 0) + 1;
    counts.set(name, count);
    if (count > 1 && SENSITIVE_SINGLETON_HEADERS.has(name)) {
      return rejected(400, "BAD_REQUEST");
    }
    if (count === 1) headers.set(name, value);
  }

  if (headers.get("host") !== options.expectedHost) {
    return rejected(403, "CROSS_ORIGIN_REQUEST");
  }
  const origin = headers.get("origin");
  if (options.kind === "navigation") {
    if (origin !== undefined && origin !== options.expectedOrigin) {
      return rejected(403, "CROSS_ORIGIN_REQUEST");
    }
  } else if (
    origin !== options.expectedOrigin ||
    headers.get("x-embassy-request") !== "1"
  ) {
    return rejected(403, "CROSS_ORIGIN_REQUEST");
  }

  return { ok: true, headers };
}

export function liveDashboardSecurityHeaders(
  contentSecurityPolicy = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
): Readonly<Record<string, string>> {
  return Object.freeze({
    "Cache-Control": "no-store",
    Pragma: "no-cache",
    "Content-Security-Policy": contentSecurityPolicy,
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Permissions-Policy":
      "accelerometer=(), camera=(), geolocation=(), microphone=(), payment=(), usb=()",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  });
}

export function readSingleCookie(
  cookieHeader: string | undefined,
  cookieName: string,
): string | undefined {
  if (
    cookieHeader === undefined ||
    cookieHeader.length > LIVE_DASHBOARD_LIMITS.maximumHeaderBytes ||
    !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(cookieName)
  ) {
    return undefined;
  }
  let found: string | undefined;
  for (const field of cookieHeader.split(";")) {
    const separator = field.indexOf("=");
    if (separator < 1) continue;
    const name = field.slice(0, separator).trim();
    if (name !== cookieName) continue;
    if (found !== undefined) return undefined;
    const value = field.slice(separator + 1).trim();
    if (!/^[A-Za-z0-9_-]{1,128}$/u.test(value)) return undefined;
    found = value;
  }
  return found;
}

export function equalSecret(
  supplied: string | undefined,
  expected: string | undefined,
): boolean {
  if (supplied === undefined || expected === undefined) return false;
  const suppliedBytes = Buffer.from(supplied, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  if (suppliedBytes.length !== expectedBytes.length) return false;
  return timingSafeEqual(suppliedBytes, expectedBytes);
}

export function sessionCookieHeader(
  cookieName: string,
  value: string,
  instancePath: string,
): string {
  if (
    !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(cookieName) ||
    !/^[A-Za-z0-9_-]{43,64}$/u.test(value) ||
    !/^\/[A-Za-z0-9_-]{16,128}$/u.test(instancePath)
  ) {
    throw new Error("INVALID_LIVE_DASHBOARD_COOKIE");
  }
  return `${cookieName}=${value}; Path=${instancePath}/; HttpOnly; SameSite=Strict`;
}
