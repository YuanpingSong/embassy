import {
  createServer,
  type IncomingMessage,
  type RequestListener,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

import { BridgeError } from "../errors.js";
import { LIVE_DASHBOARD_LIMITS } from "./live-dashboard-protocol.js";

export type LiveDashboardServerAddress = Readonly<{
  host: "127.0.0.1";
  port: number;
}>;

export type LiveDashboardHttpServer = {
  maxConnections: number;
  headersTimeout: number;
  requestTimeout: number;
  keepAliveTimeout: number;
  listen(
    options: Readonly<{
      host: "127.0.0.1";
      port: number;
      exclusive: true;
    }>,
  ): void;
  address(): AddressInfo | string | null;
  once(event: "error", callback: (error: Error) => void): void;
  once(event: "listening", callback: () => void): void;
  off(event: "error", callback: (error: Error) => void): void;
  off(event: "listening", callback: () => void): void;
  close(callback: (error?: Error) => void): void;
  closeAllConnections?(): void;
};

export type LiveDashboardHttpFactory = Readonly<{
  createServer(
    listener: (request: IncomingMessage, response: ServerResponse) => void,
  ): LiveDashboardHttpServer;
}>;

export const defaultLiveDashboardHttpFactory: LiveDashboardHttpFactory = {
  createServer: (listener) => {
    const server = createServer(
      {
        insecureHTTPParser: false,
        maxHeaderSize: LIVE_DASHBOARD_LIMITS.maximumHeaderBytes,
      },
      listener as RequestListener,
    );
    return server;
  },
};

function isIpv4LoopbackAddress(
  address: AddressInfo | string | null,
): address is AddressInfo {
  if (address === null || typeof address === "string") return false;
  return (
    address.address === "127.0.0.1" &&
    address.family === "IPv4" &&
    Number.isSafeInteger(address.port) &&
    address.port > 0 &&
    address.port <= 65_535
  );
}

async function closeServer(server: LiveDashboardHttpServer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let closeFinished = false;
    let forceFinished = false;
    let closeError: unknown;
    let forceError: unknown;
    const settle = (): void => {
      if (!closeFinished || !forceFinished) return;
      const error = closeError ?? forceError;
      if (error === undefined) resolve();
      else reject(error);
    };
    try {
      server.close((error) => {
        closeError = error;
        closeFinished = true;
        settle();
      });
    } catch (error) {
      reject(error);
      return;
    }
    try {
      server.closeAllConnections?.();
    } catch (error) {
      forceError = error;
    }
    forceFinished = true;
    settle();
  });
}

export type BoundLiveDashboardServer = Readonly<{
  address: LiveDashboardServerAddress;
  close(): Promise<void>;
}>;

function normalizedBindError(error: Error, port: number): Error {
  if (
    "code" in error &&
    (error as Error & Readonly<{ code?: unknown }>).code === "EADDRINUSE"
  ) {
    return new BridgeError(
      "LIVE_DASHBOARD_PORT_IN_USE",
      `Live dashboard port ${port} is already in use. Close the holding process or choose another with --port <n>.`,
      true,
    );
  }
  return error;
}

export async function bindLiveDashboardServer(
  server: LiveDashboardHttpServer,
  port: number,
  signal?: AbortSignal,
): Promise<BoundLiveDashboardServer> {
  server.maxConnections = LIVE_DASHBOARD_LIMITS.maximumConnections;
  server.headersTimeout = LIVE_DASHBOARD_LIMITS.headersTimeoutMs;
  server.requestTimeout = LIVE_DASHBOARD_LIMITS.requestTimeoutMs;
  server.keepAliveTimeout = LIVE_DASHBOARD_LIMITS.keepAliveTimeoutMs;

  // Port 0 is retained only as a test-owned real-listener seam. Production
  // configuration accepts 1024..65535 and always requests a stable port.
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new Error("LIVE_DASHBOARD_PORT_INVALID");
  }

  if (signal?.aborted === true) {
    throw new Error("LIVE_DASHBOARD_BIND_ABORTED");
  }
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      server.off("error", onError);
      server.off("listening", onListening);
      signal?.removeEventListener("abort", onAbort);
    };
    const onListening = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const onError = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(normalizedBindError(error, port));
    };
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        server.close(() => undefined);
      } catch {
        // The listener may not yet have entered Node's listening state.
      }
      server.closeAllConnections?.();
      reject(new Error("LIVE_DASHBOARD_BIND_ABORTED"));
    };
    server.once("error", onError);
    server.once("listening", onListening);
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      server.listen({
        host: "127.0.0.1",
        port,
        exclusive: true,
      });
    } catch (error) {
      onError(
        error instanceof Error
          ? error
          : new Error("LIVE_DASHBOARD_BIND_FAILED"),
      );
    }
  });

  const address = server.address();
  if (
    !isIpv4LoopbackAddress(address) ||
    (port !== 0 && address.port !== port)
  ) {
    await closeServer(server).catch(() => undefined);
    throw new Error("LIVE_DASHBOARD_BIND_NOT_IPV4_LOOPBACK");
  }

  let closeInFlight: Promise<void> | undefined;
  return {
    address: { host: "127.0.0.1", port: address.port },
    close: () => {
      closeInFlight ??= closeServer(server);
      return closeInFlight;
    },
  };
}
