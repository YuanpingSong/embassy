// Unit tests for the live dashboard app's data adapter (integration spec §7.3).
//
// The app bundle is compiled with `module: "none"` + `outFile`, so it cannot be
// imported. It is evaluated instead in a node:vm context with stub
// window/document/React/ReactDOM/EMBASSY_BOOT globals; the `Embassy` namespace
// (and therefore `Embassy.adapter.*` and the chip tables) lands on the vm
// global. Every derivation is a pure function, so the stubs only have to be
// inert enough for the bundle's top-level statements — `React.createContext`
// and, once `app.tsx` lands, the mount statement.
//
// Cross-realm note: values returned by the adapter carry the vm realm's
// prototypes, so `assert.deepEqual` (strict) would fail on prototype identity.
// Deep comparisons therefore go through `plain()` (a JSON round-trip into this
// realm); scalar fields — especially the `undefined` ones JSON would drop — are
// asserted individually.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Script, createContext } from "node:vm";

import {
  DASHBOARD_SEMANTICS,
  buildDashboardViewModel,
  type DashboardActivityEventRow,
  type DashboardAttentionItem,
  type DashboardMessageGroup,
  type DashboardRouteRow,
  type DashboardViewModel,
} from "../src/gateway/dashboard-model.js";
import type {
  ConnectorHealth,
  DeliveryState,
  GatewayProvider,
} from "../src/gateway/types.js";
import type { EmbassyNamespace } from "../src/gateway/live-dashboard-app/app-types.js";
import { dashboardFixture } from "./dashboard-fixture.js";

// ---------------------------------------------------------------------------
// Bundle evaluation in node:vm
// ---------------------------------------------------------------------------

const BUNDLE_URL = new URL(
  "../dist/src/gateway/live-dashboard-app/app.js",
  import.meta.url,
);
const BUNDLE_PATH = fileURLToPath(BUNDLE_URL);

type MountRecord = { container: unknown; children: unknown };

type LoadedBundle = {
  Embassy: EmbassyNamespace;
  context: Record<string, unknown>;
  source: string;
  mounts: readonly MountRecord[];
  rootElement: unknown;
};

/** A React stub whose createElement returns inert plain objects. */
function createReactStub(): Record<string, unknown> {
  const contexts: Record<string, unknown>[] = [];
  const createElement = (
    type: unknown,
    props: unknown,
    ...children: unknown[]
  ): Record<string, unknown> => ({
    $$stub: "element",
    type,
    props: props ?? {},
    children,
  });
  const createContext = (defaultValue: unknown): Record<string, unknown> => {
    const context: Record<string, unknown> = {
      $$stub: "context",
      Provider: "Context.Provider",
      Consumer: "Context.Consumer",
      _currentValue: defaultValue,
    };
    contexts.push(context);
    return context;
  };
  const base: Record<string, unknown> = {
    version: "18.3.1",
    createElement,
    cloneElement: createElement,
    createContext,
    Fragment: "Fragment",
    StrictMode: "StrictMode",
    // Hooks are never executed by these tests (the ReactDOM stub does not
    // render), but a stray call must not throw.
    useState: (initial: unknown) => [
      typeof initial === "function" ? (initial as () => unknown)() : initial,
      () => undefined,
    ],
    useReducer: (_reducer: unknown, initial: unknown) => [
      initial,
      () => undefined,
    ],
    useEffect: () => undefined,
    useLayoutEffect: () => undefined,
    useMemo: (factory: () => unknown) => factory(),
    useCallback: (callback: unknown) => callback,
    useRef: (initial: unknown) => ({ current: initial }),
    useContext: (context: Record<string, unknown>) => context._currentValue,
    useId: () => "stub-id",
    useSyncExternalStore: (
      _subscribe: unknown,
      getSnapshot: () => unknown,
    ) => getSnapshot(),
    memo: (component: unknown) => component,
    forwardRef: (component: unknown) => component,
    __contexts: contexts,
  };
  // Unknown React APIs resolve to inert no-ops so a future app.tsx cannot fail
  // the adapter suite for a reason unrelated to the adapter.
  return new Proxy(base, {
    get(target, property) {
      if (property in target) return target[property as string];
      return () => undefined;
    },
  });
}

function loadBundle(): LoadedBundle {
  if (!existsSync(BUNDLE_PATH)) {
    throw new Error(
      `Live dashboard app bundle missing at ${BUNDLE_PATH}. Run \`npm run build\` ` +
        "(it runs `tsc -p src/gateway/live-dashboard-app/tsconfig.json`) first.",
    );
  }
  const source = readFileSync(BUNDLE_PATH, "utf8");

  const mounts: MountRecord[] = [];
  const rootElement: Record<string, unknown> = {
    id: "root",
    nodeType: 1,
    className: "",
    style: {},
    setAttribute: () => undefined,
    removeAttribute: () => undefined,
    appendChild: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    focus: () => undefined,
  };
  const documentStub: Record<string, unknown> = {
    documentElement: { lang: "en", setAttribute: () => undefined },
    // Null-safe for either mount shape: a guarded lookup sees the element, an
    // unguarded `getElementById("root")!` gets a usable object.
    getElementById: (id: string) => (id === "root" ? rootElement : null),
    querySelector: (selector: string) =>
      selector === "#root" ? rootElement : null,
    createElement: () => ({
      style: {},
      setAttribute: () => undefined,
      appendChild: () => undefined,
    }),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    body: { appendChild: () => undefined },
    title: "Embassy live",
  };
  const storage = new Map<string, string>();
  const localStorageStub = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => {
      storage.set(key, value);
    },
    removeItem: (key: string) => {
      storage.delete(key);
    },
  };
  const locationStub = {
    href: "http://127.0.0.1:41961/#ignored-legacy-fragment",
    origin: "http://127.0.0.1:41961",
    protocol: "http:",
    host: "127.0.0.1:41961",
    pathname: "/",
    search: "",
    hash: "#ignored-legacy-fragment",
  };
  const historyStub = { replaceState: () => undefined };
  const reactStub = createReactStub();
  const reactDomStub = {
    version: "18.3.1",
    createRoot: (container: unknown) => ({
      render: (children: unknown) => {
        mounts.push({ container, children });
      },
      unmount: () => undefined,
    }),
  };
  const windowStub: Record<string, unknown> = {
    EMBASSY_BOOT: Object.freeze({
      locale: "en",
      copy: Object.freeze({ en: {}, "zh-CN": {} }),
      semantics: DASHBOARD_SEMANTICS,
    }),
    setTimeout: () => 0,
    clearTimeout: () => undefined,
    setInterval: () => 0,
    clearInterval: () => undefined,
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    matchMedia: () => ({
      matches: false,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }),
    document: documentStub,
    location: locationStub,
    history: historyStub,
    localStorage: localStorageStub,
    // A never-settling fetch: no network, and no unhandled rejection if a
    // future boot path starts the protocol FSM at load.
    fetch: () => new Promise<never>(() => undefined),
  };
  windowStub.window = windowStub;
  windowStub.self = windowStub;
  windowStub.globalThis = windowStub;

  const context: Record<string, unknown> = {
    window: windowStub,
    self: windowStub,
    document: documentStub,
    location: locationStub,
    history: historyStub,
    localStorage: localStorageStub,
    navigator: { clipboard: { writeText: async () => undefined } },
    console,
    React: reactStub,
    ReactDOM: reactDomStub,
    setTimeout: windowStub.setTimeout,
    clearTimeout: windowStub.clearTimeout,
    setInterval: windowStub.setInterval,
    clearInterval: windowStub.clearInterval,
    queueMicrotask,
    fetch: windowStub.fetch,
    AbortController,
    TextDecoder,
    TextEncoder,
    performance,
  };
  createContext(context);
  new Script(source, { filename: BUNDLE_PATH }).runInContext(context);

  const namespace = context.Embassy as EmbassyNamespace | undefined;
  if (namespace === undefined || namespace.adapter === undefined) {
    throw new Error(
      `${BUNDLE_PATH} evaluated without defining the Embassy.adapter namespace.`,
    );
  }
  return { Embassy: namespace, context, source, mounts, rootElement };
}

const bundle = loadBundle();
const { adapter } = bundle.Embassy;

// ---------------------------------------------------------------------------
// Fixtures and helpers
// ---------------------------------------------------------------------------

function fixture(name: string): DashboardViewModel {
  const url = new URL(`./fixtures/dashboard-model/${name}.json`, import.meta.url);
  return JSON.parse(readFileSync(url, "utf8")) as DashboardViewModel;
}

const HEALTHY = fixture("healthy-exchange");
const DEGRADED = fixture("degraded-queue");
const EMPTY = fixture("empty-first-run");
const SUCCESSION = fixture("succession-generation");

/** Re-materializes a vm-realm value in this realm so deepEqual can run. */
function plain<Value>(value: Value): Value {
  return JSON.parse(JSON.stringify(value)) as Value;
}

function at<Value>(values: readonly Value[], index: number): Value {
  const value = values[index];
  assert.notEqual(value, undefined, `expected an element at index ${index}`);
  return value as Value;
}

function ms(iso: string): number {
  return Date.parse(iso);
}

const GENERATED_MS = ms("2026-08-08T12:00:00.000Z");

/** Structural clone of a fixture, mutable for edge-case construction. */
function mutableClone(model: DashboardViewModel): {
  -readonly [Key in keyof DashboardViewModel]: DashboardViewModel[Key];
} {
  return JSON.parse(JSON.stringify(model)) as {
    -readonly [Key in keyof DashboardViewModel]: DashboardViewModel[Key];
  };
}

function withActivity(
  model: DashboardViewModel,
  activity: readonly DashboardMessageGroup[],
): DashboardViewModel {
  const next = mutableClone(model);
  next.activity = activity;
  return next;
}

function settledGroup(
  state: DeliveryState,
  timestamp: string,
  suffix: string,
): DashboardMessageGroup {
  return {
    direction: "claude_to_codex",
    sourceAlias: "claude-advisor@this-mac",
    targetAlias: "codex-builder@this-mac",
    messageIdSuffix: suffix,
    state,
    timestamp,
    bytes: 128,
    events: [{ sequence: 1, timestamp, state }],
  };
}

// ---------------------------------------------------------------------------
// Bundle + fixture sanity
// ---------------------------------------------------------------------------

test("bundle evaluates in node:vm and exposes the adapter surface", () => {
  const expected = [
    "overviewProps",
    "deliveriesGroups",
    "routesProps",
    "activityRows",
    "diagnosticsProps",
    "queueSplit",
    "routeOldestAgeMs",
    "pulse",
    "worstConnectorHealth",
    "matchesProviderFilters",
    "extractSuccessions",
    "hasLifecycleTruncation",
    "deliveriesTruncated",
    "deliveryGroupKey",
    "guidanceCopyKey",
    "attentionCommand",
    "attentionViews",
    "isTerminalDeliveryState",
    "parseTimestampMs",
  ];
  for (const name of expected) {
    assert.equal(
      typeof (adapter as unknown as Record<string, unknown>)[name],
      "function",
      `Embassy.adapter.${name} must be a function`,
    );
  }
  // The top-level mount statement must have run during evaluation above,
  // exactly once, into #root — and must not have thrown.
  if (bundle.source.includes("ReactDOM.createRoot")) {
    assert.equal(bundle.mounts.length, 1, "expected one top-level mount");
    assert.equal(at(bundle.mounts, 0).container, bundle.rootElement);
  }
  assert.match(
    bundle.source,
    /settled:\s*"watches\.event\.settled"/u,
  );
  assert.match(bundle.source, /t\("column\.observed"\)/u);
  assert.match(
    bundle.source,
    /React\.createElement\(Embassy\.TimeAgo, \{ iso: connector\.lastSeenAt \}\)/u,
  );
});

test("root browser protocol ignores fragments and uses cookie-free API posts", async () => {
  const calls: Array<Readonly<{ input: string; init: RequestInit }>> = [];
  const events: unknown[] = [];
  const snapshotEvent = {
    streamRevision: 11,
    snapshotRevision: "snapshot-10",
    reset: false,
    model: HEALTHY,
  };
  const previousFetch = bundle.context.fetch;
  bundle.context.fetch = (async (input: string, init: RequestInit) => {
    calls.push({ input, init });
    if (input.endsWith("/action")) {
      return {
        ok: true,
        json: async () => ({ ok: true, code: "ok" }),
      };
    }
    assert.equal(input.endsWith("/snapshot"), true);
    return {
      ok: true,
      json: async () => snapshotEvent,
    };
  }) as typeof fetch;
  try {
    const protocol = bundle.Embassy.createProtocol({
      onEvent: (event) => events.push(event),
      onConnectionState: () => undefined,
    });
    assert.deepEqual(
      plain(
        await protocol.executeAction({
          action: "remove_stale_codex_registration",
          alias: "codex-orphan@this-mac",
        }),
      ),
      { ok: true, code: "ok" },
    );
  } finally {
    bundle.context.fetch = previousFetch;
  }

  assert.equal(calls.length, 2);
  assert.equal(calls.some((call) => call.input.endsWith("/session")), false);
  assert.equal(calls[0]?.input, "/action");
  assert.equal(calls[0]?.init.method, "POST");
  assert.equal(calls[0]?.init.credentials, "omit");
  assert.deepEqual(plain(calls[0]?.init.headers), {
    "X-Embassy-Request": "1",
    "Content-Type": "application/json",
  });
  assert.equal(
    calls[0]?.init.body,
    JSON.stringify({
      action: "remove_stale_codex_registration",
      alias: "codex-orphan@this-mac",
    }),
  );
  assert.equal(calls[1]?.input, "/snapshot");
  assert.equal(calls[1]?.init.method, "POST");
  assert.equal(calls[1]?.init.credentials, "omit");
  assert.deepEqual(plain(calls[1]?.init.headers), {
    "X-Embassy-Request": "1",
  });
  assert.equal(calls[1]?.init.body, undefined);
  assert.deepEqual(plain(events), [snapshotEvent]);
});

test("stream capacity response reports the four-window limit", async () => {
  const calls: Array<Readonly<{ input: string; init: RequestInit }>> = [];
  const states: string[] = [];
  const previousFetch = bundle.context.fetch;
  bundle.context.fetch = (async (input: string, init: RequestInit) => {
    calls.push({ input, init });
    return { ok: false, status: 429 };
  }) as typeof fetch;
  try {
    const protocol = bundle.Embassy.createProtocol({
      onEvent: () => undefined,
      onConnectionState: (state) => states.push(state),
    });
    protocol.start();
    await new Promise<void>((resolve) => setImmediate(resolve));
  } finally {
    bundle.context.fetch = previousFetch;
  }

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.input, "/stream");
  assert.equal(calls[0]?.init.method, "POST");
  assert.equal(calls[0]?.init.credentials, "omit");
  assert.deepEqual(states, ["connecting", "capacity"]);
  assert.equal(bundle.Embassy.connectionChipKind("capacity"), "warning");
  assert.equal(
    bundle.Embassy.meaningKeyFor("connection", "capacity"),
    "live.connection.capacity",
  );
});

test("fixtures carry the full DashboardViewModel shape", () => {
  const models: readonly [string, DashboardViewModel][] = [
    ["healthy-exchange", HEALTHY],
    ["degraded-queue", DEGRADED],
    ["empty-first-run", EMPTY],
    ["succession-generation", SUCCESSION],
  ];
  const topLevelKeys = [
    "schemaVersion",
    "generatedAt",
    "health",
    "overall",
    "exchange",
    "attention",
    "transit",
    "activity",
    "peers",
    "routes",
    "consentEdges",
    "graph",
    "connectors",
    "accounting",
    "omissions",
  ];
  const omissionKeys = [
    "connectors",
    "availablePeers",
    "routes",
    "consentEdges",
    "upstreamMessageEvents",
    "messageGroups",
    "messageEvents",
    "upstreamAlerts",
    "attentionItems",
  ];
  for (const [name, model] of models) {
    assert.equal(model.schemaVersion, 2, `${name} schemaVersion`);
    const record = model as unknown as Record<string, unknown>;
    for (const key of topLevelKeys) {
      assert.ok(key in record, `${name} is missing ${key}`);
    }
    const omissions = model.omissions as unknown as Record<string, unknown>;
    for (const key of omissionKeys) {
      assert.equal(
        typeof omissions[key],
        "number",
        `${name}.omissions.${key} must be a number`,
      );
    }
    assert.equal(Object.keys(model.accounting).length, 12, `${name} accounting`);
  }
});

test("fixtures only use real protocol tokens (no chip falls back to unknown)", () => {
  for (const model of [HEALTHY, DEGRADED, EMPTY, SUCCESSION]) {
    for (const group of model.activity) {
      assert.notEqual(
        bundle.Embassy.chipKindFor(group.state, group.direction),
        "unknown",
        `unknown delivery state ${group.state}`,
      );
      for (const event of group.events) {
        assert.notEqual(
          bundle.Embassy.chipKindFor(event.state, group.direction),
          "unknown",
          `unknown event state ${event.state}`,
        );
      }
    }
    for (const route of model.routes) {
      assert.notEqual(bundle.Embassy.routeChipKind(route.state), "unknown");
    }
    for (const peer of model.peers) {
      assert.notEqual(bundle.Embassy.peerChipKind(peer.state), "unknown");
    }
    for (const connector of model.connectors) {
      assert.notEqual(bundle.Embassy.healthChipKind(connector.health), "unknown");
    }
    for (const item of model.attention) {
      assert.notEqual(bundle.Embassy.severityChipKind(item.severity), "unknown");
    }
  }
});

// ---------------------------------------------------------------------------
// §7.3 — queue split, per provider, including zero routes
// ---------------------------------------------------------------------------

test("queueSplit sums the target provider's routes only", () => {
  const nowMs = ms("2026-08-08T12:00:30.000Z");
  const toCodex = adapter.queueSplit(DEGRADED, "codex", nowMs);
  const toClaude = adapter.queueSplit(DEGRADED, "claude", nowMs);
  assert.equal(toCodex.depth, 5);
  assert.equal(toClaude.depth, 2);
  assert.equal(toCodex.oldestQueuedAt, "2026-08-08T11:52:30.000Z");
  assert.equal(toClaude.oldestQueuedAt, "2026-08-08T11:57:00.000Z");
});

test("queueSplit marks depth as a lower bound when routes were omitted", () => {
  assert.equal(DEGRADED.omissions.routes, 1);
  assert.equal(adapter.queueSplit(DEGRADED, "codex", GENERATED_MS).depthIsLowerBound, true);
  assert.equal(HEALTHY.omissions.routes, 0);
  assert.equal(adapter.queueSplit(HEALTHY, "codex", GENERATED_MS).depthIsLowerBound, false);
});

test("queueSplit returns an empty summary when the provider has no routes", () => {
  const summary = adapter.queueSplit(EMPTY, "codex", GENERATED_MS);
  assert.equal(summary.depth, 0);
  assert.equal(summary.depthIsLowerBound, false);
  assert.equal(summary.oldestQueuedAt, undefined);
  assert.equal(summary.oldestAgeMs, undefined);
});

test("queueSplit returns no age when every route of the provider is drained", () => {
  const summary = adapter.queueSplit(HEALTHY, "claude", GENERATED_MS);
  assert.equal(summary.depth, 0);
  assert.equal(summary.oldestQueuedAt, undefined);
  assert.equal(summary.oldestAgeMs, undefined);
});

test("queueSplit ignores oldestQueuedAt left behind on a drained route", () => {
  // codex-reviewer@this-mac has queueDepth 0 but still carries a 09:00 marker;
  // taking it would report a three-hour-old head for a five-message queue.
  const drained = DEGRADED.routes.find(
    (route) => route.alias === "codex-reviewer@this-mac",
  );
  assert.notEqual(drained, undefined);
  assert.equal(drained?.queueDepth, 0);
  assert.equal(drained?.oldestQueuedAt, "2026-08-08T09:00:00.000Z");
  assert.equal(
    adapter.queueSplit(DEGRADED, "codex", GENERATED_MS).oldestQueuedAt,
    "2026-08-08T11:52:30.000Z",
  );
  assert.equal(adapter.routeOldestAgeMs(drained as DashboardRouteRow, GENERATED_MS), undefined);
});

// ---------------------------------------------------------------------------
// §7.3 — oldest age from oldestQueuedAt against the injected clock (R13)
// ---------------------------------------------------------------------------

test("oldest queue age ticks on the injected clock, not the server's queueAgeMs", () => {
  const codexRoute = DEGRADED.routes.find(
    (route) => route.alias === "codex-builder@this-mac",
  ) as DashboardRouteRow;
  assert.equal(codexRoute.queueAgeMs, 450_000); // server value, as of generatedAt

  const atFrame = adapter.queueSplit(DEGRADED, "codex", GENERATED_MS);
  assert.equal(atFrame.oldestAgeMs, 450_000);

  const thirtySecondsLater = adapter.queueSplit(
    DEGRADED,
    "codex",
    GENERATED_MS + 30_000,
  );
  assert.equal(thirtySecondsLater.oldestAgeMs, 480_000);
  assert.notEqual(thirtySecondsLater.oldestAgeMs, codexRoute.queueAgeMs);

  assert.equal(
    adapter.routeOldestAgeMs(codexRoute, GENERATED_MS + 30_000),
    480_000,
  );
});

test("queue age clamps to zero when the clock is behind the enqueue time", () => {
  const behind = ms("2026-08-08T11:00:00.000Z");
  assert.equal(adapter.queueSplit(DEGRADED, "codex", behind).oldestAgeMs, 0);
});

test("queue age ignores an unparseable oldestQueuedAt", () => {
  const model = mutableClone(DEGRADED);
  const routes = model.routes.map((route) =>
    route.alias === "codex-builder@this-mac"
      ? { ...route, oldestQueuedAt: "not-a-timestamp" }
      : route,
  );
  model.routes = routes;
  const summary = adapter.queueSplit(model, "codex", GENERATED_MS);
  assert.equal(summary.depth, 5); // depth still counts
  assert.equal(summary.oldestQueuedAt, undefined);
  assert.equal(summary.oldestAgeMs, undefined);
});

// ---------------------------------------------------------------------------
// §7.3 — pulse: window, all eight terminals, lower bound
// ---------------------------------------------------------------------------

test("pulse renders all eight terminal bars in canonical order", () => {
  const canonical: DeliveryState[] = [
    "delivered",
    "unconfirmed",
    "failed",
    "ambiguous",
    "expired",
    "cancelled",
    "abandoned",
    "rejected",
  ];
  assert.deepEqual(plain(bundle.Embassy.TERMINAL_DELIVERY_STATES), canonical);
  const pulse = adapter.pulse(HEALTHY);
  assert.equal(pulse.bars.length, 8);
  assert.deepEqual(
    plain(pulse.bars).map((bar) => bar.state),
    canonical,
  );
});

test("pulse counts only terminal settlements inside the window", () => {
  const pulse = adapter.pulse(DEGRADED);
  assert.deepEqual(plain(pulse.bars), [
    { state: "delivered", count: 1 },
    { state: "unconfirmed", count: 0 },
    { state: "failed", count: 0 },
    { state: "ambiguous", count: 0 },
    // the 10:15 expiry is 105 minutes before generatedAt — outside the window
    { state: "expired", count: 0 },
    { state: "cancelled", count: 0 },
    { state: "abandoned", count: 1 },
    { state: "rejected", count: 1 },
  ]);
  assert.equal(pulse.total, 3);
});

test("pulse excludes in-flight, duplicate and held groups", () => {
  // degraded-queue carries queued / duplicate / held groups inside the window.
  const inFlight = DEGRADED.activity.filter(
    (group) => !adapter.isTerminalDeliveryState(group.state),
  );
  assert.deepEqual(
    inFlight.map((group) => group.state),
    ["queued", "duplicate", "held"],
  );
  assert.equal(adapter.pulse(DEGRADED).total, 3);
  assert.equal(adapter.pulse(HEALTHY).total, 2); // the transport_written group is excluded
});

test("pulse window boundary is inclusive at generatedAt − 3600s", () => {
  assert.equal(bundle.Embassy.PULSE_WINDOW_MS, 3_600_000);
  const onEdge = new Date(GENERATED_MS - 3_600_000).toISOString();
  const justOutside = new Date(GENERATED_MS - 3_600_001).toISOString();
  const model = withActivity(HEALTHY, [
    settledGroup("delivered", onEdge, "aaaaaa"),
    settledGroup("failed", justOutside, "bbbbbb"),
  ]);
  const bars = new Map(
    plain(adapter.pulse(model).bars).map((bar) => [bar.state, bar.count]),
  );
  assert.equal(bars.get("delivered"), 1);
  assert.equal(bars.get("failed"), 0);
});

test("pulse skips the window check when generatedAt is absent", () => {
  const model = mutableClone(HEALTHY);
  delete (model as { generatedAt?: string }).generatedAt;
  model.activity = [
    settledGroup("cancelled", "2020-01-01T00:00:00.000Z", "cccccc"),
  ];
  const bars = new Map(
    plain(adapter.pulse(model).bars).map((bar) => [bar.state, bar.count]),
  );
  assert.equal(bars.get("cancelled"), 1);
});

test("pulse count is a lower bound when groups or upstream events were dropped", () => {
  assert.equal(adapter.pulse(HEALTHY).isLowerBound, false);
  assert.equal(adapter.pulse(DEGRADED).isLowerBound, true);

  const groupsOnly = mutableClone(HEALTHY);
  groupsOnly.omissions = { ...groupsOnly.omissions, messageGroups: 2 };
  assert.equal(adapter.pulse(groupsOnly).isLowerBound, true);

  const upstreamOnly = mutableClone(HEALTHY);
  upstreamOnly.omissions = {
    ...upstreamOnly.omissions,
    upstreamMessageEvents: 4,
  };
  assert.equal(adapter.pulse(upstreamOnly).isLowerBound, true);
});

// ---------------------------------------------------------------------------
// §7.3 — worst-of connector derivations
// ---------------------------------------------------------------------------

test("worstConnectorHealth picks the worst per provider", () => {
  // degraded-queue has claude healthy@lab-mini + claude degraded@this-mac.
  assert.equal(adapter.worstConnectorHealth(DEGRADED, "claude"), "degraded");
  assert.equal(adapter.worstConnectorHealth(DEGRADED, "codex"), "offline");
  assert.equal(adapter.worstConnectorHealth(HEALTHY, "claude"), "healthy");
  assert.equal(adapter.worstConnectorHealth(HEALTHY, "codex"), "healthy");
  assert.equal(adapter.worstConnectorHealth(SUCCESSION, "codex"), "degraded");
});

test("worstConnectorHealth is undefined when no connector of the provider is observed", () => {
  assert.equal(adapter.worstConnectorHealth(EMPTY, "claude"), undefined);
  assert.equal(adapter.worstConnectorHealth(EMPTY, "codex"), undefined);
});

test("worstConnectorHealth honors the offline < degraded < connecting < healthy order", () => {
  const model = mutableClone(EMPTY);
  const template = {
    provider: "claude" as GatewayProvider,
    host: "this-mac",
    health: "healthy" as ConnectorHealth,
  };
  const order: ConnectorHealth[] = [
    "healthy",
    "connecting",
    "degraded",
    "offline",
  ];
  for (let index = 0; index < order.length; index += 1) {
    model.connectors = order
      .slice(0, index + 1)
      .map((health, position) => ({
        ...template,
        host: `host-${position}`,
        health,
      }));
    assert.equal(
      adapter.worstConnectorHealth(model, "claude"),
      at(order, index),
      `worst of ${order.slice(0, index + 1).join(",")}`,
    );
  }
});

// ---------------------------------------------------------------------------
// §7.3 — successions and routes props
// ---------------------------------------------------------------------------

test("stale-registration recovery is offered only on stale Codex rows", () => {
  const staleCodex = DEGRADED.routes.find(
    (route) => route.provider === "codex" && route.state === "stale",
  ) as DashboardRouteRow;
  const disabledCodex = DEGRADED.routes.find(
    (route) => route.provider === "codex" && route.state === "disabled",
  ) as DashboardRouteRow;
  const claude = DEGRADED.routes.find(
    (route) => route.provider === "claude",
  ) as DashboardRouteRow;

  assert.equal(
    bundle.Embassy.canRequestStaleCodexRegistrationRemoval(staleCodex),
    true,
  );
  assert.equal(
    bundle.Embassy.canRequestStaleCodexRegistrationRemoval(disabledCodex),
    false,
  );
  assert.equal(
    bundle.Embassy.canRequestStaleCodexRegistrationRemoval({
      ...claude,
      state: "stale",
    }),
    false,
  );
  assert.match(bundle.source, /remove_stale_codex_registration/u);
});

test("consent-edge candidates require enabled observed routes", () => {
  const route = DEGRADED.routes.find((candidate) => candidate.state === "idle") as DashboardRouteRow;
  assert.equal(bundle.Embassy.canOfferConsentEdgeCandidate(route), true);
  assert.equal(bundle.Embassy.canOfferConsentEdgeCandidate({ ...route, state: "awaiting_approval" }), true);
  assert.equal(bundle.Embassy.canOfferConsentEdgeCandidate({ ...route, enabled: false }), false);
  assert.equal(bundle.Embassy.canOfferConsentEdgeCandidate({ ...route, state: "stale" }), false);
});

test("routesProps keeps every provider route in server order", () => {
  const data = adapter.routesProps(DEGRADED, GENERATED_MS);
  assert.equal(data.inboundMode, "paired");
  assert.deepEqual(
    plain(data.routes).map((view) => view.route.alias),
    DEGRADED.routes.map((route) => route.alias),
  );
  assert.equal(data.routesOmitted, 1);
  assert.equal(data.peersOmitted, 3);
  assert.equal(data.peers.length, 2);
  assert.equal(data.graph.readyConsentEdgeCount, 0);
  assert.equal(data.consentEdges.length, 1);
  assert.equal(data.consentEdgesOmitted, 2);
});

test("routesProps trusts explicit DeepSeek/Grok edge provenance over aliases", () => {
  const model = mutableClone(HEALTHY);
  model.consentEdges = [{
    ...at(model.consentEdges, 0),
    endpoints: [
      { alias: "claude-looking@this-mac", provider: "deepseek" },
      { alias: "codex-looking@this-mac", provider: "grok" },
    ],
  }];
  assert.deepEqual(
    plain(adapter.routesProps(model, GENERATED_MS).consentEdges[0]?.endpoints),
    plain(model.consentEdges[0]?.endpoints),
  );
});

test("overview and routes preserve the explicit open-inbound policy", () => {
  const open = mutableClone(EMPTY);
  open.inboundMode = "open";
  assert.equal(adapter.overviewProps(open, GENERATED_MS).inboundMode, "open");
  assert.equal(adapter.routesProps(open, GENERATED_MS).inboundMode, "open");
});

test("extractSuccessions keeps only succession guidance, in server order", () => {
  const successions = adapter.extractSuccessions(SUCCESSION);
  assert.deepEqual(
    plain(successions).map((view) => [view.guidanceKey, view.item.alias]),
    [
      ["codexSuccessionRecovery", "codex-legacy@this-mac"],
      ["codexSuccessionBusy", "codex-builder@this-mac"],
    ],
  );
  assert.equal(
    at(successions, 1).command,
    "embassy register-codex --alias <new> --succeeds codex-builder@this-mac",
  );
  assert.equal(adapter.extractSuccessions(DEGRADED).length, 0);
  assert.equal(adapter.extractSuccessions(EMPTY).length, 0);
});

// ---------------------------------------------------------------------------
// §7.3 — attention guidance keys and teaching commands
// ---------------------------------------------------------------------------

test("guidanceCopyKey camelCases every guidance value", () => {
  const expected: readonly [DashboardAttentionItem["guidance"], string][] = [
    ["reobserve_claude", "reobserveClaude"],
    ["reobserve_codex", "reobserveCodex"],
    ["codex_reactivation_required", "codexReactivationRequired"],
    ["consent_edge_unavailable", "consentEdgeUnavailable"],
    ["claude_not_observed", "claudeNotObserved"],
    ["codex_stale", "codexStale"],
    ["connector_offline", "connectorOffline"],
    ["route_stale", "routeStale"],
    ["queue_stalled", "queueStalled"],
    ["recipient_waiting_input", "recipientWaitingInput"],
    ["unconfirmed", "unconfirmed"],
    ["degraded", "degraded"],
    ["codex_succession_busy", "codexSuccessionBusy"],
    ["codex_succession_recovery", "codexSuccessionRecovery"],
    ["progress_watch", "progressWatch"],
    ["generic", "generic"],
  ];
  for (const [guidance, key] of expected) {
    assert.equal(adapter.guidanceCopyKey(guidance), key);
  }
});

test("attention teaching commands are real CLI verbs", () => {
  const views = adapter.attentionViews(DEGRADED);
  assert.deepEqual(
    plain(views).map((view) => [view.guidanceKey, view.command]),
    [
      ["codexStale", "embassy register-codex --alias codex-builder@this-mac"],
      ["queueStalled", "embassy status"],
      ["degraded", "embassy status"],
      ["unconfirmed", "embassy status"],
    ],
  );
  const successionViews = adapter.attentionViews(SUCCESSION);
  assert.deepEqual(
    plain(successionViews).map((view) => view.command),
    [
      "embassy register-codex --alias <new> --succeeds codex-legacy@this-mac",
      "embassy register-codex --alias <new> --succeeds codex-builder@this-mac",
      "embassy select-claude --alias claude-advisor@this-mac",
      "embassy status",
    ],
  );
  const verbs =
    /^(EMBASSY_[A-Z_]+=\S+ )?embassy (serve|health|status|delivery-status|wait-delivery|refresh-dashboard|dashboard|register-codex|unregister-codex|select-claude|unselect-claude|send-to-claude|send-to-codex|reply)\b/;
  for (const view of [...views, ...successionViews]) {
    assert.match(view.command, verbs);
  }
});

test("registry-unavailable evidence reaches live attention exactly once", () => {
  const snapshot = dashboardFixture();
  const claude = snapshot.connectors.find(
    (connector) => connector.provider === "claude",
  );
  assert.ok(claude);
  claude.health = "degraded";
  claude.safeErrorCode = "CLAUDE_REGISTRY_UNAVAILABLE";
  claude.registry = {
    entriesScanned: 0,
    parseableRecords: 0,
    parseableRecordSeenSinceBoot: false,
    rejected: [{ safeErrorCode: "CLAUDE_REGISTRY_UNAVAILABLE", count: 1 }],
    rejectedCodesOmitted: 0,
  };

  const views = adapter
    .overviewProps(buildDashboardViewModel(snapshot), GENERATED_MS)
    .attention.filter(
      (view) => view.item.code === "CLAUDE_REGISTRY_UNAVAILABLE",
    );
  assert.deepEqual(
    plain(views).map((view) => [view.guidanceKey, view.command]),
    [["registryRejected", "embassy status"]],
  );
});

test("attention commands fall back to angle-bracket placeholders without an alias", () => {
  const anonymous: DashboardAttentionItem = {
    kind: "alert",
    severity: "warning",
    guidance: "claude_not_observed",
  };
  assert.equal(
    adapter.attentionCommand(anonymous),
    "embassy select-claude --alias <alias>",
  );
  assert.equal(
    adapter.attentionCommand({ ...anonymous, guidance: "reobserve_codex" }),
    "embassy register-codex --alias <alias>",
  );
  assert.equal(
    adapter.attentionCommand({
      ...anonymous,
      alias: "codex-reviewer@this-mac",
      guidance: "codex_reactivation_required",
    }),
    "embassy register-codex --alias codex-reviewer@this-mac",
  );
  assert.equal(
    adapter.attentionCommand({
      ...anonymous,
      guidance: "consent_edge_unavailable",
    }),
    "embassy refresh-dashboard",
  );
  assert.equal(
    adapter.attentionCommand({
      ...anonymous,
      guidance: "codex_succession_recovery",
    }),
    "embassy register-codex --alias <new> --succeeds <old>",
  );
  assert.equal(
    adapter.attentionCommand({ ...anonymous, guidance: "generic" }),
    "embassy status",
  );
});

test("live stalled-queue attention renders queue depth only when evidence carries it", () => {
  const stalled: DashboardAttentionItem = {
    kind: "alert",
    code: "QUEUE_STALLED",
    severity: "warning",
    guidance: "queue_stalled",
    queueDepth: 1_234,
  };
  const t = (key: string): string =>
    key === "app.routes.queueDepth" ? "Queue depth" : key;
  assert.equal(
    bundle.Embassy.attentionQueueDepthLine(stalled, t, "en"),
    "Queue depth: 1,234",
  );
  const { queueDepth: _queueDepth, ...withoutDepth } = stalled;
  assert.equal(
    bundle.Embassy.attentionQueueDepthLine(withoutDepth, t, "en"),
    undefined,
  );
});

// ---------------------------------------------------------------------------
// §7.3 — deliveries grouping, keys, truncation detection
// ---------------------------------------------------------------------------

test("deliveriesGroups renders model.activity verbatim, in server order", () => {
  const groups = adapter.deliveriesGroups(DEGRADED);
  assert.equal(groups.length, DEGRADED.activity.length);
  assert.deepEqual(
    plain(groups).map((view) => view.group.state),
    DEGRADED.activity.map((group) => group.state),
  );
  assert.equal(
    at(groups, 0).routePair,
    "claude-advisor@this-mac → codex-builder@this-mac",
  );
});

test("delivery provider filters compose from and to without reading aliases", () => {
  const base = at(HEALTHY.activity, 0);
  const model = withActivity(HEALTHY, [
    { ...base, direction: "deepseek_to_grok", sourceAlias: "claude-looking", targetAlias: "codex-looking" },
    { ...base, direction: "deepseek_to_codex", sourceAlias: "grok-looking", targetAlias: "claude-looking" },
    { ...base, direction: "claude_to_grok", sourceAlias: "codex-looking", targetAlias: "deepseek-looking" },
    { ...base, direction: "codex_to_claude", sourceAlias: "deepseek-looking", targetAlias: "grok-looking" },
  ]);
  const views = adapter.deliveriesGroups(model);
  const matches = (from: "all" | GatewayProvider, to: "all" | GatewayProvider) =>
    views.filter((view) => adapter.matchesProviderFilters(view, from, to)).length;
  assert.equal(matches("all", "all"), 4);
  assert.equal(matches("deepseek", "all"), 2);
  assert.equal(matches("all", "grok"), 2);
  assert.equal(matches("deepseek", "grok"), 1);
  assert.equal(matches("codex", "grok"), 0);
});

test("deliveryGroupKey uses the suffix, or the first retained sequence when absent", () => {
  const withSuffix = at(DEGRADED.activity, 0);
  assert.equal(
    adapter.deliveryGroupKey(withSuffix),
    "claude_to_codex|claude-advisor@this-mac|codex-builder@this-mac|a1b2c3d4",
  );
  const withoutSuffix = DEGRADED.activity.find(
    (group) => group.messageIdSuffix === undefined,
  ) as DashboardMessageGroup;
  assert.equal(withoutSuffix.state, "held");
  assert.equal(
    adapter.deliveryGroupKey(withoutSuffix),
    "claude_to_codex|claude-advisor@this-mac|codex-reviewer@this-mac|seq174",
  );
  const keys = adapter.deliveriesGroups(DEGRADED).map((view) => view.key);
  assert.equal(new Set(keys).size, keys.length, "row keys must be unique");
});

test("lifecycle truncation is detected from intra-group sequence gaps", () => {
  const gapped = DEGRADED.activity.find(
    (group) => group.messageIdSuffix === "77aa11",
  ) as DashboardMessageGroup;
  assert.deepEqual(
    gapped.events.map((event) => event.sequence),
    [180, 205],
  );
  assert.equal(adapter.hasLifecycleTruncation(gapped), true);

  const contiguous = at(HEALTHY.activity, 1);
  assert.deepEqual(
    contiguous.events.map((event) => event.sequence),
    [101, 102, 103, 104],
  );
  assert.equal(adapter.hasLifecycleTruncation(contiguous), false);

  const single = at(DEGRADED.activity, 0);
  assert.equal(single.events.length, 1);
  assert.equal(adapter.hasLifecycleTruncation(single), false);

  const truncatedFlags = plain(adapter.deliveriesGroups(DEGRADED)).map(
    (view) => view.eventsTruncated,
  );
  assert.deepEqual(truncatedFlags, [false, false, true, false, false, false, false]);
});

test("deliveriesTruncated fires on omitted events or on a sequence gap", () => {
  assert.equal(DEGRADED.omissions.messageEvents, 9);
  assert.equal(adapter.deliveriesTruncated(DEGRADED), true);

  assert.equal(HEALTHY.omissions.messageEvents, 0);
  assert.equal(adapter.deliveriesTruncated(HEALTHY), false);
  assert.equal(adapter.deliveriesTruncated(EMPTY), false);

  // A gap alone is enough, even with omissions.messageEvents === 0.
  const gapOnly = mutableClone(HEALTHY);
  gapOnly.activity = [
    {
      ...at(HEALTHY.activity, 1),
      events: [
        { sequence: 101, timestamp: "2026-08-08T11:59:10.000Z", state: "queued" },
        {
          sequence: 140,
          timestamp: "2026-08-08T11:59:12.000Z",
          state: "delivered",
        },
      ],
    },
  ];
  assert.equal(gapOnly.omissions.messageEvents, 0);
  assert.equal(adapter.deliveriesTruncated(gapOnly), true);
});

// ---------------------------------------------------------------------------
// §7.3 — activity union
// ---------------------------------------------------------------------------

test("activityRows merges settlements and timestamped alerts, timestamp desc", () => {
  const rows = adapter.activityRows(DEGRADED);
  assert.deepEqual(
    plain(rows).map((row) => [row.kind, row.timestamp]),
    [
      ["delivery", "2026-08-08T11:59:05.000Z"],
      ["delivery", "2026-08-08T11:58:20.000Z"],
      ["alert", "2026-08-08T11:58:00.000Z"],
      ["alert", "2026-08-08T11:57:10.000Z"],
      ["alert", "2026-08-08T11:56:02.000Z"],
      ["delivery", "2026-08-08T11:45:00.000Z"],
      ["delivery", "2026-08-08T10:15:00.000Z"],
    ],
  );
});

test("activityRows includes body-free broker operations in timeline order", () => {
  const model = mutableClone(EMPTY);
  model.brokerActivity = [
    {
      sequence: 1,
      timestamp: "2026-08-08T12:00:00.000Z",
      kind: "pairing",
      action: "routes_paired",
      outcome: "accepted",
      aliases: ["claude-alpha@this-mac", "codex-main@this-mac"],
      operatorAction: true,
    },
  ];
  assert.deepEqual(plain(adapter.activityRows(model)), [
    {
      kind: "operation",
      timestamp: "2026-08-08T12:00:00.000Z",
      event: model.brokerActivity[0],
    },
  ]);
});

test("live activity authority labels automatic refreshes and operator recovery distinctly", () => {
  const endpoint: DashboardActivityEventRow = {
    sequence: 1,
    timestamp: "2026-08-08T12:00:00.000Z",
    kind: "endpoint",
    action: "endpoint_refreshed",
    outcome: "accepted",
    aliases: ["codex-main@this-mac"],
    operatorAction: false,
  };
  const recovery: DashboardActivityEventRow = {
    sequence: 2,
    timestamp: "2026-08-08T12:00:01.000Z",
    kind: "recovery",
    action: "codex_orphan_removed",
    outcome: "accepted",
    aliases: ["codex-orphan@this-mac"],
    operatorAction: true,
  };

  assert.equal(bundle.Embassy.activityAuthority(endpoint), "automatic");
  assert.equal(bundle.Embassy.activityAuthority(recovery), "operator");
  assert.match(bundle.source, /data-activity-authority/u);
});

test("activityRows drops in-flight groups and alerts without a timestamp", () => {
  const rows = plain(adapter.activityRows(DEGRADED));
  const alertGuidance = rows
    .filter((row) => row.kind === "alert")
    .map((row) => (row.kind === "alert" ? row.guidanceKey : ""));
  // ADAPTER_DEGRADED carries no timestamp and must not be placed on the timeline.
  assert.deepEqual(alertGuidance, ["codexStale", "queueStalled", "unconfirmed"]);
  assert.equal(
    DEGRADED.attention.filter((item) => item.timestamp === undefined).length,
    1,
  );
  const deliveryStates = rows
    .filter((row) => row.kind === "delivery")
    .map((row) => (row.kind === "delivery" ? row.group.state : ""));
  assert.deepEqual(deliveryStates, [
    "abandoned",
    "rejected",
    "delivered",
    "expired",
  ]);
});

test("activityRows breaks timestamp ties by source alias ascending", () => {
  const model = mutableClone(DEGRADED);
  const tie = "2026-08-08T11:50:00.000Z";
  model.activity = [
    {
      ...settledGroup("delivered", tie, "eeeeee"),
      sourceAlias: "claude-zulu@this-mac",
    },
    {
      ...settledGroup("delivered", tie, "ffffff"),
      sourceAlias: "claude-alpha@this-mac",
    },
  ];
  model.attention = [];
  assert.deepEqual(
    plain(adapter.activityRows(model)).map((row) =>
      row.kind === "delivery" ? row.group.sourceAlias : "",
    ),
    ["claude-alpha@this-mac", "claude-zulu@this-mac"],
  );
});

// ---------------------------------------------------------------------------
// §7.3 — chip resolution: qualified direction rule, held/duplicate/rejected,
// loud unknown, abandoned annotation by safe code
// ---------------------------------------------------------------------------

test("delivered is qualified only for codex_to_claude (H2)", () => {
  assert.equal(bundle.Embassy.chipKindFor("delivered", "codex_to_claude"), "qualified");
  assert.equal(bundle.Embassy.chipKindFor("delivered", "claude_to_codex"), "positive");
  assert.equal(bundle.Embassy.chipKindFor("delivered"), "positive");
  assert.equal(
    bundle.Embassy.chipKindByDomain("delivery", "delivered", "codex_to_claude"),
    "qualified",
  );
  // The rule is driven by (state, direction) — the direction alone changes nothing.
  assert.equal(bundle.Embassy.chipKindFor("failed", "codex_to_claude"), "failure");

  const settled = SUCCESSION.activity.find(
    (group) => group.state === "delivered",
  ) as DashboardMessageGroup;
  assert.equal(settled.direction, "codex_to_claude");
  assert.equal(
    bundle.Embassy.chipKindFor(settled.state, settled.direction),
    "qualified",
  );
});

test("held is progress, duplicate is inert, rejected is warning", () => {
  assert.equal(bundle.Embassy.chipKindFor("held"), "progress");
  assert.equal(bundle.Embassy.chipKindFor("duplicate"), "inert");
  // PM ruling: a by-design refusal is actionable (coral warning), never
  // failure-red.
  assert.equal(bundle.Embassy.chipKindFor("rejected"), "warning");
  assert.equal(
    bundle.Embassy.chipKindFor(
      "rejected",
      "claude_to_codex",
      "SENDER_NOT_PAIRED",
    ),
    "inert",
  );
  assert.equal(bundle.Embassy.chipKindFor("cancelled"), "inert");
  assert.equal(bundle.Embassy.chipKindFor("abandoned"), "inert");
  assert.equal(bundle.Embassy.chipKindFor("queued"), "progress");
  assert.equal(bundle.Embassy.chipKindFor("dispatching"), "progress");
  assert.equal(bundle.Embassy.chipKindFor("transport_written"), "progress");
  assert.equal(bundle.Embassy.chipKindFor("unconfirmed"), "indeterminate");
  assert.equal(bundle.Embassy.chipKindFor("ambiguous"), "indeterminate");
  assert.equal(bundle.Embassy.deliveryMeaningKey("held"), "activity.meaning.held");
  assert.equal(
    bundle.Embassy.deliveryMeaningKey("duplicate"),
    "activity.meaning.duplicate",
  );
  assert.equal(
    bundle.Embassy.deliveryMeaningKey("rejected"),
    "activity.meaning.rejected",
  );
  assert.equal(
    bundle.Embassy.deliveryMeaningKey("rejected", undefined, "SENDER_NOT_PAIRED"),
    "activity.meaning.senderNotPaired",
  );
});

test("unknown tokens fall back loudly, never to inert", () => {
  // Phantom states from the prototype must not resolve silently.
  for (const phantom of [
    "accepted",
    "released",
    "dispatched",
    "refused",
    "stalled",
    "transport-written",
    "",
  ]) {
    assert.equal(
      bundle.Embassy.chipKindFor(phantom),
      "unknown",
      `${phantom} must render the loud unknown chip`,
    );
  }
  // Inherited Object.prototype members are not states either.
  assert.equal(bundle.Embassy.chipKindFor("toString"), "unknown");
  assert.equal(bundle.Embassy.chipKindFor("constructor"), "unknown");
  assert.equal(bundle.Embassy.routeChipKind("paired"), "unknown");
  assert.equal(bundle.Embassy.peerChipKind("selected"), "unknown");
  assert.equal(bundle.Embassy.healthChipKind("ok"), "unknown");
  assert.equal(bundle.Embassy.severityChipKind("critical"), "unknown");
  assert.equal(bundle.Embassy.connectionChipKind("reconnecting"), "unknown");
  assert.equal(
    bundle.Embassy.deliveryMeaningKey("released"),
    "activity.meaning.other",
  );
});

test("abandoned annotation is selected by safeErrorCode (H4)", () => {
  assert.equal(
    bundle.Embassy.deliveryMeaningKey("abandoned", undefined, "CONTROLLER_RESTARTED"),
    "activity.meaning.abandoned.controllerRestarted",
  );
  assert.equal(
    bundle.Embassy.deliveryMeaningKey("abandoned", undefined, "TRANSIENT_BODY_UNAVAILABLE"),
    "activity.meaning.abandoned.transientBody",
  );
  assert.equal(
    bundle.Embassy.deliveryMeaningKey("abandoned", undefined, "ROUTE_UNREGISTERED"),
    "activity.meaning.abandoned.routeTerminated",
  );
  assert.equal(
    bundle.Embassy.deliveryMeaningKey("abandoned", undefined, "MESSAGE_EXPIRED"),
    "activity.meaning.abandoned.routeTerminated",
  );
  assert.equal(
    bundle.Embassy.deliveryMeaningKey("abandoned", undefined, "SOMETHING_ELSE"),
    "activity.meaning.abandoned.generic",
  );
  assert.equal(
    bundle.Embassy.deliveryMeaningKey("abandoned"),
    "activity.meaning.abandoned.generic",
  );

  const group = DEGRADED.activity.find(
    (candidate) => candidate.state === "abandoned",
  ) as DashboardMessageGroup;
  assert.equal(group.safeErrorCode, "CONTROLLER_RESTARTED");
  assert.equal(
    bundle.Embassy.deliveryMeaningKey(
      group.state,
      group.direction,
      group.safeErrorCode,
    ),
    "activity.meaning.abandoned.controllerRestarted",
  );
  // The chip kind stays inert regardless of which annotation is chosen.
  assert.equal(bundle.Embassy.chipKindFor(group.state, group.direction), "inert");
});

test("delivered hover meaning localizes by direction, other states do not", () => {
  assert.equal(
    bundle.Embassy.deliveryMeaningKey("delivered", "codex_to_claude"),
    "activity.meaning.delivered.toClaude",
  );
  assert.equal(
    bundle.Embassy.deliveryMeaningKey("delivered", "claude_to_codex"),
    "activity.meaning.delivered.toCodex",
  );
  assert.equal(
    bundle.Embassy.deliveryMeaningKey("delivered", "grok_to_deepseek"),
    "activity.meaning.delivered.toDeepSeek",
  );
  assert.equal(
    bundle.Embassy.deliveryMeaningKey("delivered", "deepseek_to_grok"),
    "activity.meaning.delivered.toGrok",
  );
  assert.equal(
    bundle.Embassy.deliveryMeaningKey("delivered"),
    "activity.meaning.delivered",
  );
  assert.equal(
    bundle.Embassy.meaningKeyFor("route", "awaiting_approval"),
    "route.meaning.awaitingApproval",
  );
  assert.equal(bundle.Embassy.meaningKeyFor("peer", "offline"), "peer.meaning.offline");
});

// ---------------------------------------------------------------------------
// §7.3 — composed tab props, healthy and degraded
// ---------------------------------------------------------------------------

test("overviewProps composes the status strip, queues and attention", () => {
  const nowMs = GENERATED_MS + 30_000;
  const data = adapter.overviewProps(DEGRADED, nowMs);
  assert.equal(data.generatedAt, "2026-08-08T12:00:00.000Z");
  assert.equal(data.overall, "attention");
  assert.equal(data.statusStrip.broker, "degraded");
  assert.deepEqual(
    plain(data.statusStrip.providers).map((row) => [row.provider, row.health]),
    [["claude", "degraded"], ["codex", "offline"], ["deepseek", undefined], ["grok", undefined]],
  );
  const queues = new Map(data.providerQueues.map((row) => [row.provider, row.queue]));
  assert.equal(queues.get("codex")?.depth, 5);
  assert.equal(queues.get("codex")?.oldestAgeMs, 480_000);
  assert.equal(queues.get("claude")?.depth, 2);
  assert.equal(queues.get("claude")?.oldestAgeMs, 210_000);
  assert.equal(queues.get("deepseek")?.depth, 0);
  assert.equal(data.graph.readyConsentEdgeCount, 0);
  assert.equal(data.degradedConsentEdgeCopyKey, "app.overview.degradedEdges");
  assert.equal(data.attention.length, 4);
  assert.equal(data.attentionOmitted, 5);
  assert.equal(data.pulse.total, 3);
  assert.equal(data.pulse.isLowerBound, true);
  assert.equal(data.exchange.queuedMessages, 7);
  assert.equal(data.exchange.queueCountIsLowerBound, true);
});

test("overviewProps on a healthy exchange reports no attention and a live pair", () => {
  const data = adapter.overviewProps(HEALTHY, GENERATED_MS);
  assert.equal(data.statusStrip.broker, "healthy");
  assert.deepEqual(
    plain(data.statusStrip.providers).map((row) => row.provider),
    ["claude", "codex", "deepseek", "grok"],
  );
  assert.equal(data.graph.readyConsentEdgeCount, 1);
  assert.equal(data.degradedConsentEdgeCopyKey, undefined);
  assert.equal(data.attention.length, 0);
  assert.equal(data.attentionOmitted, 0);
  assert.equal(data.pulse.total, 2);
  assert.equal(data.pulse.isLowerBound, false);
  assert.equal(data.providerQueues.every((row) => row.queue.depth === 0), true);
  assert.equal(data.providerQueues.every((row) => row.queue.oldestAgeMs === undefined), true);
});

test("overview consent-edge note distinguishes one degraded edge from several", () => {
  const mixed = mutableClone(HEALTHY);
  mixed.graph = {
    ...mixed.graph,
    consentEdgeCount: 2,
    readyConsentEdgeCount: 1,
  };
  assert.equal(
    adapter.overviewProps(mixed, GENERATED_MS).degradedConsentEdgeCopyKey,
    "app.overview.degradedEdge",
  );

  mixed.graph = {
    ...mixed.graph,
    consentEdgeCount: 3,
  };
  assert.equal(
    adapter.overviewProps(mixed, GENERATED_MS).degradedConsentEdgeCopyKey,
    "app.overview.degradedEdges",
  );
});

test("diagnosticsProps forwards counters, omissions and queue pressure", () => {
  const data = adapter.diagnosticsProps(DEGRADED);
  assert.equal(data.connectors.length, 3);
  assert.equal(data.connectorsOmitted, 0);
  assert.equal(data.expiredCount, DEGRADED.accounting.expired);
  assert.equal(data.expiredCount, 3);
  assert.equal(data.queuedMessages, 7);
  assert.equal(data.queueCountIsLowerBound, true);
  assert.deepEqual(plain(data.accounting), plain(DEGRADED.accounting));
  assert.deepEqual(plain(data.omissions), plain(DEGRADED.omissions));
});

test("diagnosticsProps preserves bounded connector registry evidence", () => {
  const model = mutableClone(DEGRADED);
  model.connectors = model.connectors.map((connector) =>
    connector.provider === "claude"
      ? {
          ...connector,
          registry: {
            entriesScanned: 2,
            parseableRecords: 1,
            parseableRecordSeenSinceBoot: true,
            rejected: [
              { safeErrorCode: "REGISTRY_INVALID_SCHEMA", count: 1 },
            ],
            rejectedCodesOmitted: 0,
          },
        }
      : connector,
  );
  const claude = model.connectors.find(
    (connector) => connector.provider === "claude",
  );
  assert.ok(claude?.registry);
  const projected = adapter.diagnosticsProps(model).connectors.find(
    (connector) => connector.provider === "claude",
  );
  assert.deepEqual(plain(projected?.registry), plain(claude.registry));
});

test("diagnosticsProps preserves Codex doctor conditions", () => {
  const model = mutableClone(DEGRADED);
  model.connectors = model.connectors.map((connector) =>
    connector.provider === "codex"
      ? {
          ...connector,
          codexDoctor: {
            conditions: ["orphaned", "observation_stale"] as const,
          },
        }
      : connector,
  );
  const projected = adapter.diagnosticsProps(model).connectors.find(
    (connector) => connector.provider === "codex",
  );
  assert.deepEqual(plain(projected?.codexDoctor), {
    conditions: ["orphaned", "observation_stale"],
  });
});

// ---------------------------------------------------------------------------
// §7.3 — empty inputs never throw
// ---------------------------------------------------------------------------

test("empty peers, routes, connectors and activity produce empty props, never a throw", () => {
  const nowMs = ms("2026-08-08T09:30:45.000Z");
  const overview = adapter.overviewProps(EMPTY, nowMs);
  assert.equal(overview.statusStrip.broker, "connecting");
  assert.deepEqual(
    plain(overview.statusStrip.providers).map((row) => [row.provider, row.health]),
    [["claude", undefined], ["codex", undefined], ["deepseek", undefined], ["grok", undefined]],
  );
  assert.equal(overview.attention.length, 0);
  assert.equal(overview.attentionOmitted, 0);
  assert.equal(overview.graph.readyConsentEdgeCount, 0);
  assert.equal(overview.pulse.total, 0);
  assert.equal(overview.pulse.bars.length, 8);
  assert.equal(overview.pulse.isLowerBound, false);
  assert.equal(overview.providerQueues.length, 4);
  assert.equal(overview.providerQueues.every((row) => row.queue.depth === 0), true);

  const routes = adapter.routesProps(EMPTY, nowMs);
  assert.equal(routes.peers.length, 0);
  assert.equal(routes.routes.length, 0);
  assert.equal(routes.consentEdges.length, 0);
  assert.equal(routes.successions.length, 0);
  assert.equal(routes.peersOmitted, 0);
  assert.equal(routes.routesOmitted, 0);

  assert.equal(adapter.deliveriesGroups(EMPTY).length, 0);
  assert.equal(adapter.activityRows(EMPTY).length, 0);
  assert.equal(adapter.deliveriesTruncated(EMPTY), false);

  const diagnostics = adapter.diagnosticsProps(EMPTY);
  assert.equal(diagnostics.connectors.length, 0);
  assert.equal(diagnostics.expiredCount, 0);
  assert.equal(diagnostics.queuedMessages, 0);
});

test("a model with no generatedAt and no arrays still derives cleanly", () => {
  const model = mutableClone(EMPTY);
  delete (model as { generatedAt?: string }).generatedAt;
  assert.doesNotThrow(() => adapter.overviewProps(model, Date.now()));
  assert.equal(adapter.overviewProps(model, Date.now()).generatedAt, undefined);
  assert.equal(adapter.pulse(model).total, 0);
  assert.equal(adapter.parseTimestampMs(undefined), undefined);
  assert.equal(adapter.parseTimestampMs("not-a-date"), undefined);
  assert.equal(
    adapter.parseTimestampMs("2026-08-08T12:00:00.000Z"),
    GENERATED_MS,
  );
});

test("terminal-state classification matches the closed 13-token vocabulary", () => {
  const terminal: DeliveryState[] = [
    "delivered",
    "unconfirmed",
    "failed",
    "ambiguous",
    "expired",
    "cancelled",
    "abandoned",
    "rejected",
  ];
  const nonTerminal: DeliveryState[] = [
    "queued",
    "dispatching",
    "transport_written",
    "held",
    "duplicate",
  ];
  for (const state of terminal) {
    assert.equal(adapter.isTerminalDeliveryState(state), true, state);
  }
  for (const state of nonTerminal) {
    assert.equal(adapter.isTerminalDeliveryState(state), false, state);
  }
  assert.equal(terminal.length + nonTerminal.length, 13);
});
