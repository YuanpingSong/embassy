import { execFile } from "node:child_process";

import { BridgeError } from "../errors.js";
import type { DashboardLocale } from "./dashboard-copy.js";
import { loadGatewayConfig, type GatewayConfig } from "./config.js";
import {
  GATEWAY_CONTROL_PROTOCOL_VERSION,
  sendGatewayControlRequest,
  type GatewayControlMethod,
  type GatewayControlResponse,
  type SendGatewayControlRequestOptions,
} from "./control.js";
import {
  isLiveDashboardStartupCancelled,
  startLiveDashboard,
  type RunningLiveDashboard,
  type StartLiveDashboardOptions,
} from "./live-dashboard.js";
import type { LiveDashboardObserver } from "./live-dashboard-stream.js";

const OPEN_EXECUTABLE = "/usr/bin/open";
const OPEN_TIMEOUT_MS = 10_000;
const OPEN_MAX_OUTPUT_BYTES = 16 * 1024;
const OPEN_ENVIRONMENT = Object.freeze({
  PATH: "/usr/bin:/bin",
  LANG: "C",
  LC_ALL: "C",
});

type GatewaySignal = "SIGINT" | "SIGTERM";

export type LiveDashboardReadyResult = Readonly<{
  status: "ready";
  mode: "live";
  locale: DashboardLocale;
}>;

export type LiveDashboardCommandOutcome = Readonly<{
  status: "cancelled";
}>;

export type LiveDashboardCommandOptions = Readonly<{
  env?: NodeJS.ProcessEnv;
  locale: DashboardLocale;
  signal?: AbortSignal;
  onReady: (result: LiveDashboardReadyResult) => void | Promise<void>;
  loadConfig?: (env: NodeJS.ProcessEnv) => GatewayConfig;
  validateControlSocket: (
    stateDir: string,
    socketPath: string,
  ) => Promise<void>;
  sendRequest?: GatewayControlSender;
}>;

type GatewayControlSender = <M extends GatewayControlMethod>(
  options: SendGatewayControlRequestOptions<M>,
) => Promise<GatewayControlResponse<M>>;

type OpenExecutor = (
  executable: typeof OPEN_EXECUTABLE,
  args: readonly [string],
  options: Readonly<{
    cwd: "/";
    env: Readonly<Record<string, string>>;
    shell: false;
    timeout: typeof OPEN_TIMEOUT_MS;
    maxBuffer: typeof OPEN_MAX_OUTPUT_BYTES;
    windowsHide: true;
    signal: AbortSignal;
  }>,
) => Promise<void>;

export type LiveDashboardCommandDependencies = Readonly<{
  startDashboard?: (
    options: StartLiveDashboardOptions,
  ) => Promise<RunningLiveDashboard>;
  executeOpen?: OpenExecutor;
  addSignalListener?: (
    signal: GatewaySignal,
    listener: () => void,
  ) => void;
  removeSignalListener?: (
    signal: GatewaySignal,
    listener: () => void,
  ) => void;
}>;

type ShutdownLatch = Readonly<{
  wait: Promise<void>;
  signal: AbortSignal;
  isStopped(): boolean;
  dispose(): void;
}>;

type StartupOutcome =
  | Readonly<{ kind: "started"; dashboard: RunningLiveDashboard }>
  | Readonly<{ kind: "failed"; error: unknown }>;

function defaultOpenExecutor(
  executable: typeof OPEN_EXECUTABLE,
  args: readonly [string],
  options: Parameters<OpenExecutor>[2],
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    execFile(executable, [...args], options, (error) => {
      if (error === null) resolve();
      else reject(error);
    });
  });
}

function createShutdownLatch(
  signal: AbortSignal | undefined,
  addSignalListener: (
    signal: GatewaySignal,
    listener: () => void,
  ) => void,
  removeSignalListener: (
    signal: GatewaySignal,
    listener: () => void,
  ) => void,
): ShutdownLatch {
  let resolveWait: (() => void) | undefined;
  let stopped = false;
  let disposed = false;
  let sigintOwned = false;
  let sigtermOwned = false;
  let abortOwned = false;
  const shutdown = new AbortController();
  const wait = new Promise<void>((resolve) => {
    resolveWait = resolve;
  });
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    shutdown.abort();
    resolveWait?.();
  };
  const onSigint = (): void => stop();
  const onSigterm = (): void => stop();

  const releaseOwnedListeners = (): unknown[] => {
    const errors: unknown[] = [];
    if (abortOwned) {
      abortOwned = false;
      try {
        signal?.removeEventListener("abort", stop);
      } catch (error) {
        errors.push(error);
      }
    }
    if (sigtermOwned) {
      sigtermOwned = false;
      try {
        removeSignalListener("SIGTERM", onSigterm);
      } catch (error) {
        errors.push(error);
      }
    }
    if (sigintOwned) {
      sigintOwned = false;
      try {
        removeSignalListener("SIGINT", onSigint);
      } catch (error) {
        errors.push(error);
      }
    }
    return errors;
  };

  try {
    addSignalListener("SIGINT", onSigint);
    sigintOwned = true;
    addSignalListener("SIGTERM", onSigterm);
    sigtermOwned = true;
    if (signal !== undefined) {
      signal.addEventListener("abort", stop, { once: true });
      abortOwned = true;
    }
    if (signal?.aborted === true) stop();
  } catch (error) {
    const cleanupErrors = releaseOwnedListeners();
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        "Live dashboard signal setup failed.",
      );
    }
    throw error;
  }

  return {
    wait,
    signal: shutdown.signal,
    isStopped: () => stopped,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      const cleanupErrors = releaseOwnedListeners();
      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          cleanupErrors,
          "Live dashboard signal cleanup failed.",
        );
      }
    },
  };
}

function withoutProviderIdentity(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const operatorEnvironment = { ...env };
  // The live dashboard is an operator command. Inherited provider identity is
  // neither an authorization requirement nor forwarded to a child process.
  delete operatorEnvironment.CODEX_THREAD_ID;
  delete operatorEnvironment.CLAUDE_CODE_MESSAGING_SOCKET;
  return operatorEnvironment;
}

export function createGatewayLiveDashboardObserver(
  socketPath: string,
  sendRequest: GatewayControlSender = sendGatewayControlRequest,
): LiveDashboardObserver {
  return {
    observe: async () => {
      const response = await sendRequest({
        socketPath,
        request: {
          protocolVersion: GATEWAY_CONTROL_PROTOCOL_VERSION,
          method: "observe_snapshot",
          params: {},
        },
      });
      if (!response.ok) {
        // Stream machinery converts this closed failure into its fixed offline
        // event. Wire diagnostics are intentionally never forwarded to the UI.
        throw new Error("LIVE_DASHBOARD_OBSERVER_UNAVAILABLE");
      }
      return response.result;
    },
  };
}

async function openPrivateBootstrap(
  bootstrapPath: string,
  executeOpen: OpenExecutor,
  signal: AbortSignal,
): Promise<void> {
  try {
    await executeOpen(OPEN_EXECUTABLE, [bootstrapPath], {
      cwd: "/",
      env: OPEN_ENVIRONMENT,
      shell: false,
      timeout: OPEN_TIMEOUT_MS,
      maxBuffer: OPEN_MAX_OUTPUT_BYTES,
      windowsHide: true,
      signal,
    });
  } catch {
    throw new BridgeError(
      "LIVE_DASHBOARD_OPEN_FAILED",
      "Embassy could not ask the operating system to open the live dashboard.",
      true,
    );
  }
}

function ownLateStartup(outcome: Promise<StartupOutcome>): void {
  void outcome.then(async (result) => {
    if (result.kind !== "started") return;
    await result.dashboard.close().catch(() => undefined);
  });
}

/**
 * Run the opt-in live dashboard in the foreground until interrupted.
 *
 * The controller remains the only source of state. This command makes one
 * read-only observer available to the authenticated stream and exposes no
 * provider operation or generic control-plane escape hatch.
 */
export async function runLiveDashboardCommand(
  options: LiveDashboardCommandOptions,
  dependencies: LiveDashboardCommandDependencies = {},
): Promise<LiveDashboardCommandOutcome> {
  const env = withoutProviderIdentity(options.env ?? process.env);
  const loadConfig = options.loadConfig ?? loadGatewayConfig;
  const sendRequest = options.sendRequest ?? sendGatewayControlRequest;
  const startDashboard = dependencies.startDashboard ?? startLiveDashboard;
  const executeOpen = dependencies.executeOpen ?? defaultOpenExecutor;
  const addSignalListener =
    dependencies.addSignalListener ??
    ((signal: GatewaySignal, listener: () => void) => {
      process.on(signal, listener);
    });
  const removeSignalListener =
    dependencies.removeSignalListener ??
    ((signal: GatewaySignal, listener: () => void) => {
      process.off(signal, listener);
    });

  const config = loadConfig(env);
  await options.validateControlSocket(
    config.stateDir,
    config.controlSocketPath,
  );

  let latch: ShutdownLatch | undefined;
  let running: RunningLiveDashboard | undefined;
  let operationError: unknown;
  try {
    latch = createShutdownLatch(
      options.signal,
      addSignalListener,
      removeSignalListener,
    );
    if (!latch.isStopped()) {
      const startup = startDashboard({
        privateStateRoot: config.stateDir,
        observer: createGatewayLiveDashboardObserver(
          config.controlSocketPath,
          sendRequest,
        ),
        locale: options.locale,
        signal: latch.signal,
        dependencies: {
          openBootstrap: async (bootstrapPath) => {
            if (latch?.isStopped() !== false) {
              throw new Error("LIVE_DASHBOARD_START_CANCELLED");
            }
            await openPrivateBootstrap(
              bootstrapPath,
              executeOpen,
              latch.signal,
            );
          },
        },
      })
        .then<StartupOutcome>((dashboard) => ({
          kind: "started",
          dashboard,
        }))
        .catch<StartupOutcome>((error: unknown) => ({
          kind: "failed",
          error,
        }));
      const startupOrShutdown = await Promise.race([
        startup,
        latch.wait.then(() => ({ kind: "cancelled" as const })),
      ]);
      if (startupOrShutdown.kind === "cancelled") {
        // A Promise alone cannot keep the process alive. If startup owns a
        // late server handle, that handle does keep the foreground process
        // alive long enough for this exact continuation to close it.
        ownLateStartup(startup);
      } else if (
        startupOrShutdown.kind === "failed" &&
        !(
          latch.isStopped() &&
          isLiveDashboardStartupCancelled(startupOrShutdown.error)
        )
      ) {
        throw startupOrShutdown.error;
      } else if (startupOrShutdown.kind === "started") {
        running = startupOrShutdown.dashboard;
        if (!latch.isStopped()) {
          await options.onReady({
            status: "ready",
            mode: "live",
            locale: options.locale,
          });
          await latch.wait;
        }
      }
    }
  } catch (error) {
    operationError = error;
  }

  const cleanupErrors: unknown[] = [];
  if (running !== undefined) {
    await running.close().catch((error: unknown) => {
      cleanupErrors.push(error);
    });
  }
  if (latch !== undefined) {
    try {
      latch.dispose();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }

  if (operationError !== undefined && cleanupErrors.length === 0) {
    throw operationError;
  }
  if (operationError !== undefined || cleanupErrors.length > 0) {
    throw new AggregateError(
      [
        ...(operationError === undefined ? [] : [operationError]),
        ...cleanupErrors,
      ],
      "Live dashboard command failed.",
    );
  }
  return { status: "cancelled" };
}
