import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import {
  getDashboardCopy,
  type DashboardLocale,
} from "./dashboard-copy.js";
import { renderLiveDashboardAssets } from "./live-dashboard-assets.js";
import {
  createLiveDashboardBootstrap,
  type LiveDashboardFileSystem,
  type LiveDashboardRandomBytes,
} from "./live-dashboard-bootstrap.js";
import { createLiveDashboardRequestHandler } from "./live-dashboard-http.js";
import { liveDashboardSecurityHeaders } from "./live-dashboard-protocol.js";
import {
  bindLiveDashboardServer,
  defaultLiveDashboardHttpFactory,
  type LiveDashboardHttpFactory,
  type LiveDashboardServerAddress,
} from "./live-dashboard-server.js";
import {
  createLiveDashboardStreamHub,
  type LiveDashboardClock,
  type LiveDashboardObserver,
} from "./live-dashboard-stream.js";

export type LiveDashboardDependencies = Readonly<{
  random?: LiveDashboardRandomBytes;
  fileSystem?: LiveDashboardFileSystem;
  http?: LiveDashboardHttpFactory;
  clock?: LiveDashboardClock;
  openBootstrap?: (bootstrapPath: string) => Promise<void> | void;
}>;

export type StartLiveDashboardOptions = Readonly<{
  privateStateRoot: string;
  observer: LiveDashboardObserver;
  locale?: DashboardLocale;
  signal?: AbortSignal;
  dependencies?: LiveDashboardDependencies;
}>;

export type RunningLiveDashboard = Readonly<{
  address: LiveDashboardServerAddress;
  bootstrapPath: string;
  close(): Promise<void>;
}>;

export class LiveDashboardStartupCancelledError extends Error {
  readonly code = "LIVE_DASHBOARD_START_CANCELLED" as const;

  constructor() {
    super("Live dashboard startup was cancelled.");
    this.name = "LiveDashboardStartupCancelledError";
  }
}

export function isLiveDashboardStartupCancelled(
  error: unknown,
): error is LiveDashboardStartupCancelledError {
  return (
    error instanceof LiveDashboardStartupCancelledError ||
    (typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "LIVE_DASHBOARD_START_CANCELLED")
  );
}

function throwIfStartupCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new LiveDashboardStartupCancelledError();
  }
}

async function awaitStartupStep<T>(
  operation: Promise<T>,
  signal: AbortSignal | undefined,
  onLateSuccess?: (value: T) => Promise<void> | void,
): Promise<T> {
  if (signal === undefined) return operation;
  if (signal.aborted) {
    void operation.then(
      (value) => Promise.resolve(onLateSuccess?.(value)).catch(() => undefined),
      () => undefined,
    );
    throw new LiveDashboardStartupCancelledError();
  }
  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      reject(new LiveDashboardStartupCancelledError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void operation.then(
      (value) => {
        if (settled) {
          void Promise.resolve(onLateSuccess?.(value)).catch(() => undefined);
          return;
        }
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function randomBase64Url(
  size: number,
  random: LiveDashboardRandomBytes,
): string {
  const value = Buffer.from(random(size)).toString("base64url");
  const expectedLength = size === 16 ? 22 : size === 32 ? 43 : undefined;
  if (
    expectedLength === undefined ||
    value.length !== expectedLength ||
    !/^[A-Za-z0-9_-]+$/u.test(value)
  ) {
    throw new Error("LIVE_DASHBOARD_RANDOM_SOURCE_INVALID");
  }
  return value;
}

function notReadyHandler(
  lang: DashboardLocale,
): (request: IncomingMessage, response: ServerResponse) => void {
  const body = `${getDashboardCopy(lang)["live.http.starting"]}\n`;
  return (_request, response) => {
    if (response.headersSent) {
      response.end();
      return;
    }
    response.writeHead(503, {
      ...liveDashboardSecurityHeaders(),
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Length": String(Buffer.byteLength(body, "utf8")),
    });
    response.end(body);
  };
}

export async function startLiveDashboard(
  options: StartLiveDashboardOptions,
): Promise<RunningLiveDashboard> {
  throwIfStartupCancelled(options.signal);
  const dependencies = options.dependencies ?? {};
  const random = dependencies.random ?? randomBytes;
  const http = dependencies.http ?? defaultLiveDashboardHttpFactory;
  const locale = options.locale ?? "en";
  const instancePath = `/${randomBase64Url(16, random)}`;
  const sessionSecret = randomBase64Url(32, random);
  const assets = renderLiveDashboardAssets(locale);
  const hub = createLiveDashboardStreamHub({
    observer: options.observer,
    ...(dependencies.clock === undefined ? {} : { clock: dependencies.clock }),
  });

  let activeHandler = notReadyHandler(locale);
  const server = http.createServer((request, response) => {
    void activeHandler(request, response);
  });
  let bound:
    | Awaited<ReturnType<typeof bindLiveDashboardServer>>
    | undefined;
  let bootstrap:
    | Awaited<ReturnType<typeof createLiveDashboardBootstrap>>
    | undefined;
  try {
    bound = await bindLiveDashboardServer(server, options.signal);
    throwIfStartupCancelled(options.signal);
    const expectedHost = `${bound.address.host}:${bound.address.port}`;
    const expectedOrigin = `http://${expectedHost}`;
    const bootstrapOperation = createLiveDashboardBootstrap({
      privateStateRoot: options.privateStateRoot,
      bootstrapTargetWithoutFragment: `${expectedOrigin}${instancePath}/bootstrap`,
      lang: locale,
      random,
      ...(dependencies.fileSystem === undefined
        ? {}
        : { fileSystem: dependencies.fileSystem }),
    });
    bootstrap = await awaitStartupStep(
      bootstrapOperation,
      options.signal,
      async (lateBootstrap) => await lateBootstrap.close(),
    );
    throwIfStartupCancelled(options.signal);
    activeHandler = createLiveDashboardRequestHandler({
      instancePath,
      expectedHost,
      expectedOrigin,
      capability: bootstrap.capability,
      sessionSecret,
      cookieName: "embassy_live",
      lang: locale,
      assets,
      hub,
    });
    if (dependencies.openBootstrap !== undefined) {
      await awaitStartupStep(
        Promise.resolve(dependencies.openBootstrap(bootstrap.bootstrapPath)),
        options.signal,
      );
    }
    throwIfStartupCancelled(options.signal);
  } catch (error) {
    hub.shutdown();
    await bound?.close().catch(() => undefined);
    await bootstrap?.close().catch(() => undefined);
    if (options.signal?.aborted === true) {
      throw new LiveDashboardStartupCancelledError();
    }
    throw error;
  }

  let closeInFlight: Promise<void> | undefined;
  const close = async (): Promise<void> => {
    if (closeInFlight !== undefined) return closeInFlight;
    closeInFlight = (async () => {
      options.signal?.removeEventListener("abort", onAbortAfterReady);
      hub.shutdown();
      let closeError: unknown;
      try {
        await bound.close();
      } catch (error) {
        closeError = error;
      }
      try {
        await bootstrap.close();
      } catch (error) {
        closeError ??= error;
      }
      if (closeError !== undefined) throw closeError;
    })();
    return closeInFlight;
  };

  const onAbortAfterReady = (): void => {
    void close().catch(() => undefined);
  };
  options.signal?.addEventListener("abort", onAbortAfterReady, { once: true });
  if (options.signal?.aborted === true) {
    await close();
    throw new LiveDashboardStartupCancelledError();
  }

  return {
    address: bound.address,
    bootstrapPath: bootstrap.bootstrapPath,
    close,
  };
}
