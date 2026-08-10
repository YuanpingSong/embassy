import type { IncomingMessage, ServerResponse } from "node:http";

import {
  getDashboardCopy,
  type DashboardLocale,
} from "./dashboard-copy.js";
import { renderLiveDashboardAssets } from "./live-dashboard-assets.js";
import {
  createLiveDashboardRequestHandler,
  type LiveDashboardActionExecutor,
} from "./live-dashboard-http.js";
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
  http?: LiveDashboardHttpFactory;
  clock?: LiveDashboardClock;
  openDashboard?: (url: string) => Promise<void> | void;
}>;

export type StartLiveDashboardOptions = Readonly<{
  port: number;
  observer: LiveDashboardObserver;
  actions: LiveDashboardActionExecutor;
  locale?: DashboardLocale;
  signal?: AbortSignal;
  dependencies?: LiveDashboardDependencies;
}>;

export type RunningLiveDashboard = Readonly<{
  address: LiveDashboardServerAddress;
  url: string;
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
  const http = dependencies.http ?? defaultLiveDashboardHttpFactory;
  const locale = options.locale ?? "en";
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
  let url: string | undefined;
  try {
    bound = await bindLiveDashboardServer(server, options.port, options.signal);
    throwIfStartupCancelled(options.signal);
    const expectedHost = `${bound.address.host}:${bound.address.port}`;
    const expectedOrigin = `http://${expectedHost}`;
    url = `${expectedOrigin}/`;
    activeHandler = createLiveDashboardRequestHandler({
      expectedHost,
      expectedOrigin,
      lang: locale,
      assets,
      hub,
      actions: options.actions,
      ...(dependencies.clock === undefined
        ? {}
        : { now: dependencies.clock.now }),
    });
    if (dependencies.openDashboard !== undefined) {
      await awaitStartupStep(
        Promise.resolve(dependencies.openDashboard(url)),
        options.signal,
      );
    }
    throwIfStartupCancelled(options.signal);
  } catch (error) {
    hub.shutdown();
    await bound?.close().catch(() => undefined);
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
    url,
    close,
  };
}
