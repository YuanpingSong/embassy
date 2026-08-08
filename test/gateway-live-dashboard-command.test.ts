import assert from "node:assert/strict";
import { test } from "node:test";

import { BridgeError } from "../src/errors.js";
import {
  runGatewayCli,
  gatewayCliExitCodes,
  type GatewayCliDependencies,
} from "../src/gateway/cli.js";
import { GatewayControlTransportError } from "../src/gateway/control.js";
import {
  createGatewayLiveDashboardObserver,
  runLiveDashboardCommand,
  type LiveDashboardCommandOptions,
} from "../src/gateway/live-dashboard-command.js";
import type { StartLiveDashboardOptions } from "../src/gateway/live-dashboard.js";
import type { GatewayPublicSnapshot } from "../src/gateway/types.js";

const THREAD_ID = "00000000-0000-7000-8000-000000000701";
const CLAUDE_SOCKET_PATH = "/tmp/cc-socks/private-identity.sock";
const STATE_DIR = "/private/embassy-state";
const CONTROL_SOCKET_PATH = `${STATE_DIR}/control.sock`;
const BOOTSTRAP_PATH = `${STATE_DIR}/live-dashboard-private.html`;

type Capture = Readonly<{
  chunks: string[];
  write(chunk: string): void;
}>;

function capture(): Capture {
  const chunks: string[] = [];
  return {
    chunks,
    write: (chunk) => {
      chunks.push(chunk);
    },
  };
}

function emptySnapshot(): GatewayPublicSnapshot {
  return {
    schemaVersion: 1,
    generatedAt: "2026-08-08T12:00:00.000Z",
    health: "healthy",
    connectors: [],
    availablePeers: [],
    routes: [],
    messages: [],
    accounting: {
      accepted: 0,
      duplicates: 0,
      delivered: 0,
      unconfirmed: 0,
      failed: 0,
      ambiguous: 0,
      expired: 0,
      cancelled: 0,
      abandoned: 0,
      rejected: 0,
      bytesAccepted: 0,
      queuedBytes: 0,
    },
    alerts: [],
    truncation: {
      connectors: 0,
      availablePeers: 0,
      routes: 0,
      messages: 0,
      alerts: 0,
    },
  };
}

function cliHarness(
  runLiveDashboard: NonNullable<
    GatewayCliDependencies["runLiveDashboard"]
  >,
  env: NodeJS.ProcessEnv = {},
): {
  dependencies: GatewayCliDependencies;
  stdout: Capture;
  stderr: Capture;
} {
  const stdout = capture();
  const stderr = capture();
  return {
    stdout,
    stderr,
    dependencies: {
      env,
      stdout,
      stderr,
      runLiveDashboard,
      loadConfig: () => {
        throw new Error("the injected live runner owns configuration");
      },
      validateControlSocket: async () => {
        throw new Error("the injected live runner owns socket validation");
      },
      sendRequest: async () => {
        throw new Error("the injected live runner owns observation");
      },
    },
  };
}

test("dashboard --live preserves its closed grammar and uses common locale precedence", async () => {
  const valid = [
    { argv: ["dashboard", "--live"], env: {}, expected: "en" },
    {
      argv: ["dashboard", "--live"],
      env: { EMBASSY_LOCALE: "zh-CN" },
      expected: "zh-CN",
    },
    {
      argv: ["dashboard", "--live", "--lang", "en"],
      env: { EMBASSY_LOCALE: "zh-CN" },
      expected: "en",
    },
    {
      argv: ["dashboard", "--lang", "zh-CN", "--live"],
      env: { EMBASSY_LOCALE: "unsupported" },
      expected: "zh-CN",
    },
  ] as const;

  for (const current of valid) {
    const calls: string[] = [];
    const harness = cliHarness(async (options) => {
      calls.push(options.locale);
      await options.onReady({
        status: "ready",
        mode: "live",
        locale: options.locale,
      });
    }, {
      LANG: "zh_CN.UTF-8",
      LC_ALL: "zh_CN.UTF-8",
      LANGUAGE: "zh_CN:zh",
      CODEX_THREAD_ID: THREAD_ID,
      CLAUDE_CODE_MESSAGING_SOCKET: CLAUDE_SOCKET_PATH,
      ...current.env,
    });
    const code = await runGatewayCli(current.argv, harness.dependencies);
    assert.equal(code, gatewayCliExitCodes.ok);
    assert.deepEqual(calls, [current.expected]);
    assert.deepEqual(JSON.parse(harness.stdout.chunks.join("")), {
      ok: true,
      command: "dashboard",
      result: {
        status: "ready",
        mode: "live",
        locale: current.expected,
      },
    });
    assert.equal(harness.stderr.chunks.join(""), "");
  }

  const invalid = [
    ["dashboard"],
    ["dashboard", "--lang", "en"],
    ["dashboard", "--live", "--live"],
    ["dashboard", "--live", "--lang", "en", "--lang", "zh-CN"],
    ["dashboard", "--live", "--lang", "zh"],
    ["dashboard", "--live", "--lang", "EN"],
    ["dashboard", "--live", "--lang"],
    ["dashboard", "--live", "--unknown"],
    ["dashboard", "live"],
  ];
  for (const argv of invalid) {
    let ran = false;
    const harness = cliHarness(async () => {
      ran = true;
    });
    const code = await runGatewayCli(argv, harness.dependencies);
    assert.equal(code, gatewayCliExitCodes.invalidInput, argv.join(" "));
    assert.equal(ran, false, argv.join(" "));
    assert.deepEqual(JSON.parse(harness.stdout.chunks.join("")), {
      ok: false,
      command: "dashboard",
      error: {
        code: "INVALID_ARGUMENTS",
        ambiguous: false,
        retryable: false,
      },
    });
    assert.equal(
      harness.stderr.chunks.join(""),
      argv.length === 1 || argv[1] === "--lang"
        ? "[embassy] request rejected.\n[embassy] dashboard requires --live; static files are published by serve and refresh-dashboard.\n"
        : "[embassy] request rejected.\n",
    );
  }

  let ranWithInvalidEnvironment = false;
  const invalidEnvironment = cliHarness(async () => {
    ranWithInvalidEnvironment = true;
  }, { EMBASSY_LOCALE: "zh" });
  const invalidEnvironmentCode = await runGatewayCli(
    ["dashboard", "--live"],
    invalidEnvironment.dependencies,
  );
  assert.equal(invalidEnvironmentCode, gatewayCliExitCodes.invalidInput);
  assert.equal(ranWithInvalidEnvironment, false);
  assert.deepEqual(JSON.parse(invalidEnvironment.stdout.chunks.join("")), {
    ok: false,
    command: "dashboard",
    error: {
      code: "INVALID_ARGUMENTS",
      ambiguous: false,
      retryable: false,
    },
  });
  assert.equal(
    invalidEnvironment.stderr.chunks.join(""),
    "[embassy] request rejected.\n",
  );
});

test("live dashboard ready output is one safe result with no private launch material", async () => {
  const harness = cliHarness(async (options) => {
    await options.onReady({
      status: "ready",
      mode: "live",
      locale: options.locale,
    });
  }, {
    CODEX_THREAD_ID: THREAD_ID,
    CLAUDE_CODE_MESSAGING_SOCKET: CLAUDE_SOCKET_PATH,
    PRIVATE_CAPABILITY: "capability-secret",
  });

  const code = await runGatewayCli(
    ["dashboard", "--live", "--lang", "zh-CN"],
    harness.dependencies,
  );
  const output = harness.stdout.chunks.join("");
  assert.equal(code, gatewayCliExitCodes.ok);
  assert.equal(harness.stdout.chunks.length, 1);
  assert.deepEqual(JSON.parse(output), {
    ok: true,
    command: "dashboard",
    result: { status: "ready", mode: "live", locale: "zh-CN" },
  });
  assert.doesNotMatch(
    output,
    /127\.0\.0\.1|[Pp]ort|bootstrap|control\.sock|capability|revision|cc-socks|00000000/,
  );
  assert.equal(harness.stderr.chunks.join(""), "");
});

test("live command validates private state, opens one scrubbed bootstrap path, observes read-only, and waits for signal", async () => {
  const events: string[] = [];
  const listeners = new Map<string, () => void>();
  let startOptions: StartLiveDashboardOptions | undefined;
  let readyResolve: (() => void) | undefined;
  const ready = new Promise<void>((resolve) => {
    readyResolve = resolve;
  });
  let settled = false;
  let observedConfigEnvironment: NodeJS.ProcessEnv | undefined;
  const observedRequests: unknown[] = [];

  const run = runLiveDashboardCommand(
    {
      env: {
        EMBASSY_STATE_DIR: STATE_DIR,
        CODEX_THREAD_ID: THREAD_ID,
        CLAUDE_CODE_MESSAGING_SOCKET: CLAUDE_SOCKET_PATH,
        SECRET_SENTINEL: "must-not-reach-open",
      },
      locale: "zh-CN",
      loadConfig: (env) => {
        events.push("load");
        observedConfigEnvironment = env;
        return {
          stateDir: STATE_DIR,
          controlSocketPath: CONTROL_SOCKET_PATH,
          allowedHosts: ["this-mac"],
          stallNoticeMs: 30_000,
          limits: {} as never,
        };
      },
      validateControlSocket: async (stateDir, socketPath) => {
        events.push("validate");
        assert.equal(stateDir, STATE_DIR);
        assert.equal(socketPath, CONTROL_SOCKET_PATH);
      },
      sendRequest: (async (options: unknown) => {
        events.push("observe");
        observedRequests.push(options);
        return {
          protocolVersion: 1,
          ok: true,
          result: { snapshotRevision: 7, snapshot: emptySnapshot() },
        };
      }) as NonNullable<LiveDashboardCommandOptions["sendRequest"]>,
      onReady: (result) => {
        events.push("ready");
        assert.deepEqual(result, {
          status: "ready",
          mode: "live",
          locale: "zh-CN",
        });
        readyResolve?.();
      },
    },
    {
      addSignalListener: (signal, listener) => {
        events.push(`add:${signal}`);
        listeners.set(signal, listener);
      },
      removeSignalListener: (signal, listener) => {
        events.push(`remove:${signal}`);
        assert.equal(listeners.get(signal), listener);
        listeners.delete(signal);
      },
      executeOpen: async (executable, args, options) => {
        events.push("open");
        assert.equal(executable, "/usr/bin/open");
        assert.deepEqual(args, [BOOTSTRAP_PATH]);
        const { signal, ...fixedOptions } = options;
        assert.equal(signal.aborted, false);
        assert.deepEqual(fixedOptions, {
          cwd: "/",
          env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
          shell: false,
          timeout: 10_000,
          maxBuffer: 16 * 1024,
          windowsHide: true,
        });
        assert.equal("CODEX_THREAD_ID" in options.env, false);
        assert.equal("CLAUDE_CODE_MESSAGING_SOCKET" in options.env, false);
        assert.equal("SECRET_SENTINEL" in options.env, false);
      },
      startDashboard: async (options) => {
        events.push("start");
        startOptions = options;
        assert.equal(options.privateStateRoot, STATE_DIR);
        assert.equal(options.locale, "zh-CN");
        assert.equal(options.signal?.aborted, false);
        await options.dependencies?.openBootstrap?.(BOOTSTRAP_PATH);
        return {
          address: { host: "127.0.0.1", port: 53_421 },
          bootstrapPath: BOOTSTRAP_PATH,
          close: async () => {
            events.push("close");
          },
        };
      },
    },
  ).finally(() => {
    settled = true;
  });

  await ready;
  assert.equal(settled, false, "the foreground command must wait after ready");
  assert.equal(observedConfigEnvironment?.CODEX_THREAD_ID, undefined);
  assert.equal(
    observedConfigEnvironment?.CLAUDE_CODE_MESSAGING_SOCKET,
    undefined,
  );
  assert.equal(observedRequests.length, 0, "no broker request occurs before an authenticated stream observes");

  const observation = await startOptions?.observer.observe();
  assert.deepEqual(observation, {
    snapshotRevision: 7,
    snapshot: emptySnapshot(),
  });
  assert.deepEqual(observedRequests, [
    {
      socketPath: CONTROL_SOCKET_PATH,
      request: {
        protocolVersion: 1,
        method: "observe_snapshot",
        params: {},
      },
    },
  ]);

  listeners.get("SIGTERM")?.();
  await run;
  assert.equal(settled, true);
  assert.deepEqual(events, [
    "load",
    "validate",
    "add:SIGINT",
    "add:SIGTERM",
    "start",
    "open",
    "ready",
    "observe",
    "close",
    "remove:SIGTERM",
    "remove:SIGINT",
  ]);
  assert.equal(listeners.size, 0);
});

test("control socket validation fails before signal, server, observer, or opener side effects", async () => {
  const cases = [
    new BridgeError(
      "CONTROL_SOCKET_UNAVAILABLE",
      "private missing socket detail",
      true,
    ),
    new BridgeError(
      "CONTROL_STATE_UNSAFE",
      "private unsafe state detail",
    ),
  ];

  for (const expected of cases) {
    const effects: string[] = [];
    await assert.rejects(
      runLiveDashboardCommand(
        {
          env: {},
          locale: "en",
          loadConfig: () => {
            effects.push("load");
            return {
              stateDir: STATE_DIR,
              controlSocketPath: CONTROL_SOCKET_PATH,
              allowedHosts: ["this-mac"],
              stallNoticeMs: 30_000,
              limits: {} as never,
            };
          },
          validateControlSocket: async () => {
            effects.push("validate");
            throw expected;
          },
          sendRequest: async () => {
            effects.push("observe");
            throw new Error("must not observe");
          },
          onReady: () => {
            effects.push("ready");
          },
        },
        {
          addSignalListener: () => {
            effects.push("signal");
          },
          removeSignalListener: () => {
            effects.push("remove-signal");
          },
          startDashboard: async () => {
            effects.push("start");
            throw new Error("must not start");
          },
          executeOpen: async () => {
            effects.push("open");
          },
        },
      ),
      (error: unknown) => error === expected,
    );
    assert.deepEqual(effects, ["load", "validate"], expected.code);
  }
});

test("a pre-aborted live command never starts, opens, or emits ready", async () => {
  const controller = new AbortController();
  controller.abort();
  const events: string[] = [];
  await runLiveDashboardCommand(
    {
      env: {},
      locale: "en",
      signal: controller.signal,
      loadConfig: () => ({
        stateDir: STATE_DIR,
        controlSocketPath: CONTROL_SOCKET_PATH,
        allowedHosts: ["this-mac"],
        stallNoticeMs: 30_000,
        limits: {} as never,
      }),
      validateControlSocket: async () => {
        events.push("validate");
      },
      onReady: () => {
        events.push("ready");
      },
    },
    {
      addSignalListener: (signal) => events.push(`add:${signal}`),
      removeSignalListener: (signal) => events.push(`remove:${signal}`),
      executeOpen: async () => {
        events.push("open");
      },
      startDashboard: async () => {
        events.push("start");
        throw new Error("must not start");
      },
    },
  );
  assert.deepEqual(events, [
    "validate",
    "add:SIGINT",
    "add:SIGTERM",
    "remove:SIGTERM",
    "remove:SIGINT",
  ]);
});

test("pre-ready cancellation is a clean integrated CLI exit with no readiness claim", async () => {
  const controller = new AbortController();
  controller.abort();
  const stdout = capture();
  const stderr = capture();
  let validated = 0;
  const code = await runGatewayCli(["dashboard", "--live"], {
    env: {
      CODEX_THREAD_ID: THREAD_ID,
      CLAUDE_CODE_MESSAGING_SOCKET: CLAUDE_SOCKET_PATH,
    },
    liveDashboardSignal: controller.signal,
    stdout,
    stderr,
    loadConfig: () => ({
      stateDir: STATE_DIR,
      controlSocketPath: CONTROL_SOCKET_PATH,
      allowedHosts: ["this-mac"],
      stallNoticeMs: 30_000,
      limits: {} as never,
    }),
    validateControlSocket: async () => {
      validated += 1;
    },
    sendRequest: async () => {
      throw new Error("cancelled live command must not observe");
    },
  });
  assert.equal(code, gatewayCliExitCodes.ok);
  assert.equal(validated, 1);
  assert.equal(stdout.chunks.join(""), "");
  assert.equal(stderr.chunks.join(""), "");
});

test("SIGTERM during integrated CLI startup exits cleanly without a ready record", async () => {
  const stdout = capture();
  const stderr = capture();
  const listeners = new Map<string, () => void>();
  let startedResolve: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    startedResolve = resolve;
  });
  const run = runGatewayCli(["dashboard", "--live"], {
    env: {},
    stdout,
    stderr,
    loadConfig: () => ({
      stateDir: STATE_DIR,
      controlSocketPath: CONTROL_SOCKET_PATH,
      allowedHosts: ["this-mac"],
      stallNoticeMs: 30_000,
      limits: {} as never,
    }),
    validateControlSocket: async () => undefined,
    runLiveDashboard: async (options) =>
      await runLiveDashboardCommand(options, {
        addSignalListener: (signal, listener) =>
          listeners.set(signal, listener),
        removeSignalListener: (signal) => {
          listeners.delete(signal);
        },
        startDashboard: async () => {
          startedResolve?.();
          return await new Promise<never>(() => undefined);
        },
      }),
  });
  await started;
  listeners.get("SIGTERM")?.();
  const code = await run;
  assert.equal(code, gatewayCliExitCodes.ok);
  assert.equal(stdout.chunks.join(""), "");
  assert.equal(stderr.chunks.join(""), "");
  assert.equal(listeners.size, 0);
});

test("a signal releases a hung startup without opening or emitting ready", async () => {
  const listeners = new Map<string, () => void>();
  let startedResolve: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    startedResolve = resolve;
  });
  let ready = false;
  let opened = false;
  const run = runLiveDashboardCommand(
    {
      env: {},
      locale: "en",
      loadConfig: () => ({
        stateDir: STATE_DIR,
        controlSocketPath: CONTROL_SOCKET_PATH,
        allowedHosts: ["this-mac"],
        stallNoticeMs: 30_000,
        limits: {} as never,
      }),
      validateControlSocket: async () => undefined,
      onReady: () => {
        ready = true;
      },
    },
    {
      addSignalListener: (signal, listener) => listeners.set(signal, listener),
      removeSignalListener: (signal) => {
        listeners.delete(signal);
      },
      executeOpen: async () => {
        opened = true;
      },
      startDashboard: async () => {
        startedResolve?.();
        return await new Promise<never>(() => undefined);
      },
    },
  );
  await started;
  listeners.get("SIGINT")?.();
  await run;
  assert.equal(ready, false);
  assert.equal(opened, false);
  assert.equal(listeners.size, 0);
});

test("a cancelled startup fences a late open and closes any late-owned dashboard", async () => {
  const listeners = new Map<string, () => void>();
  let releaseStart: (() => void) | undefined;
  const startGate = new Promise<void>((resolve) => {
    releaseStart = resolve;
  });
  let enteredResolve: (() => void) | undefined;
  const entered = new Promise<void>((resolve) => {
    enteredResolve = resolve;
  });
  let openCalls = 0;
  let readyCalls = 0;
  const fenced = runLiveDashboardCommand(
    {
      env: {},
      locale: "en",
      loadConfig: () => ({
        stateDir: STATE_DIR,
        controlSocketPath: CONTROL_SOCKET_PATH,
        allowedHosts: ["this-mac"],
        stallNoticeMs: 30_000,
        limits: {} as never,
      }),
      validateControlSocket: async () => undefined,
      onReady: () => {
        readyCalls += 1;
      },
    },
    {
      addSignalListener: (signal, listener) => listeners.set(signal, listener),
      removeSignalListener: (signal) => {
        listeners.delete(signal);
      },
      executeOpen: async () => {
        openCalls += 1;
      },
      startDashboard: async (options) => {
        enteredResolve?.();
        await startGate;
        await options.dependencies?.openBootstrap?.(BOOTSTRAP_PATH);
        throw new Error("cancelled startup must not return a dashboard");
      },
    },
  );
  await entered;
  listeners.get("SIGTERM")?.();
  await fenced;
  releaseStart?.();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(openCalls, 0);
  assert.equal(readyCalls, 0);

  const lateListeners = new Map<string, () => void>();
  let resolveLate:
    | ((dashboard: {
        address: { host: "127.0.0.1"; port: number };
        bootstrapPath: string;
        close(): Promise<void>;
      }) => void)
    | undefined;
  const lateStart = new Promise<{
    address: { host: "127.0.0.1"; port: number };
    bootstrapPath: string;
    close(): Promise<void>;
  }>((resolve) => {
    resolveLate = resolve;
  });
  let lateClosed = 0;
  let lateEnteredResolve: (() => void) | undefined;
  const lateEntered = new Promise<void>((resolve) => {
    lateEnteredResolve = resolve;
  });
  const lateRun = runLiveDashboardCommand(
    {
      env: {},
      locale: "en",
      loadConfig: () => ({
        stateDir: STATE_DIR,
        controlSocketPath: CONTROL_SOCKET_PATH,
        allowedHosts: ["this-mac"],
        stallNoticeMs: 30_000,
        limits: {} as never,
      }),
      validateControlSocket: async () => undefined,
      onReady: () => {
        readyCalls += 1;
      },
    },
    {
      addSignalListener: (signal, listener) =>
        lateListeners.set(signal, listener),
      removeSignalListener: (signal) => {
        lateListeners.delete(signal);
      },
      startDashboard: async () => {
        lateEnteredResolve?.();
        return await lateStart;
      },
    },
  );
  await lateEntered;
  lateListeners.get("SIGTERM")?.();
  await lateRun;
  resolveLate?.({
    address: { host: "127.0.0.1", port: 53_422 },
    bootstrapPath: BOOTSTRAP_PATH,
    close: async () => {
      lateClosed += 1;
    },
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(lateClosed, 1);
  assert.equal(readyCalls, 0);
});

test("observer rejects a closed broker error without exposing its wire diagnostic", async () => {
  const observer = createGatewayLiveDashboardObserver(
    CONTROL_SOCKET_PATH,
    (async () => ({
      protocolVersion: 1,
      ok: false,
      error: { code: "HANDLER_FAILURE", message: "private broker detail" },
    })) as NonNullable<LiveDashboardCommandOptions["sendRequest"]>,
  );
  await assert.rejects(
    observer.observe(),
    (error: unknown) =>
      error instanceof Error &&
      error.message === "LIVE_DASHBOARD_OBSERVER_UNAVAILABLE" &&
      !error.message.includes("private broker detail"),
  );
});

test("live command cleans signal ownership after pre-ready open failure", async () => {
  const events: string[] = [];
  let ready = false;
  await assert.rejects(
    runLiveDashboardCommand(
      {
        env: {},
        locale: "en",
        loadConfig: () => ({
          stateDir: STATE_DIR,
          controlSocketPath: CONTROL_SOCKET_PATH,
          allowedHosts: ["this-mac"],
          stallNoticeMs: 30_000,
          limits: {} as never,
        }),
        validateControlSocket: async () => undefined,
        onReady: () => {
          ready = true;
        },
      },
      {
        addSignalListener: (signal) => events.push(`add:${signal}`),
        removeSignalListener: (signal) => events.push(`remove:${signal}`),
        executeOpen: async () => {
          events.push("open");
          throw new Error("private launch detail");
        },
        startDashboard: async (options) => {
          await options.dependencies?.openBootstrap?.(BOOTSTRAP_PATH);
          throw new Error("unreachable");
        },
      },
    ),
    (error: unknown) =>
      error instanceof BridgeError &&
      error.code === "LIVE_DASHBOARD_OPEN_FAILED",
  );
  assert.equal(ready, false);
  assert.deepEqual(events, [
    "add:SIGINT",
    "add:SIGTERM",
    "open",
    "remove:SIGTERM",
    "remove:SIGINT",
  ]);
});

test("CLI normalizes live failures before ready and emits no second JSON after ready", async () => {
  const preReadyCases = [
    {
      error: new GatewayControlTransportError(
        "CONTROL_CONNECT_FAILED",
        "private socket path",
      ),
      code: gatewayCliExitCodes.unavailable,
      safeCode: "CONTROL_CONNECT_FAILED",
      stderr: "[embassy] gateway unavailable.\n",
    },
    {
      error: new BridgeError(
        "LIVE_DASHBOARD_OPEN_FAILED",
        "private open detail",
        true,
      ),
      code: gatewayCliExitCodes.unavailable,
      safeCode: "LIVE_DASHBOARD_OPEN_FAILED",
      stderr: "[embassy] gateway unavailable.\n",
    },
    {
      error: new Error("private startup detail"),
      code: gatewayCliExitCodes.failure,
      safeCode: "INTERNAL_ERROR",
      stderr: "[embassy] command failed.\n",
    },
  ] as const;

  for (const current of preReadyCases) {
    const harness = cliHarness(async () => {
      throw current.error;
    });
    const code = await runGatewayCli(
      ["dashboard", "--live"],
      harness.dependencies,
    );
    assert.equal(code, current.code);
    const parsed = JSON.parse(harness.stdout.chunks.join("")) as {
      ok: boolean;
      error: { code: string };
    };
    assert.equal(parsed.ok, false);
    assert.equal(parsed.error.code, current.safeCode);
    assert.equal(harness.stderr.chunks.join(""), current.stderr);
    assert.doesNotMatch(harness.stdout.chunks.join(""), /private|socket path/);
  }

  const noReady = cliHarness(async () => undefined);
  const noReadyCode = await runGatewayCli(
    ["dashboard", "--live"],
    noReady.dependencies,
  );
  assert.equal(noReadyCode, gatewayCliExitCodes.failure);
  assert.deepEqual(JSON.parse(noReady.stdout.chunks.join("")), {
    ok: false,
    command: "dashboard",
    error: {
      code: "INTERNAL_ERROR",
      ambiguous: false,
      retryable: false,
    },
  });
  assert.equal(noReady.stderr.chunks.join(""), "[embassy] command failed.\n");

  const postReady = cliHarness(async (options) => {
    await options.onReady({
      status: "ready",
      mode: "live",
      locale: options.locale,
    });
    throw new Error("private cleanup detail");
  });
  const code = await runGatewayCli(
    ["dashboard", "--live"],
    postReady.dependencies,
  );
  assert.equal(code, gatewayCliExitCodes.failure);
  assert.equal(postReady.stdout.chunks.length, 1);
  assert.equal(
    (JSON.parse(postReady.stdout.chunks.join("")) as { ok: boolean }).ok,
    true,
  );
  assert.equal(postReady.stderr.chunks.join(""), "[embassy] command failed.\n");
  assert.doesNotMatch(postReady.stdout.chunks.join(""), /private cleanup/);
});

test("duplicate live ready callbacks cannot append protocol output", async () => {
  const harness = cliHarness(async (options) => {
    const result = {
      status: "ready" as const,
      mode: "live" as const,
      locale: options.locale,
    };
    await options.onReady(result);
    await options.onReady(result);
  });
  const code = await runGatewayCli(
    ["dashboard", "--live"],
    harness.dependencies,
  );
  assert.equal(code, gatewayCliExitCodes.failure);
  assert.equal(harness.stdout.chunks.length, 1);
  assert.equal(harness.stderr.chunks.join(""), "[embassy] command failed.\n");
});
