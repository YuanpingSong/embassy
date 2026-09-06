import type { EndpointRow, Section, TuiModel } from "../../src/gateway/tui-model.js";

export const FIXED_TUI_NOW = Date.parse("2026-09-06T18:30:00.000Z");

export const tuiDesignScenes = [
  "endpoints",
  "deliveries",
  "retirements",
  "result",
  "retirement-confirm",
  "token",
  "stale-unreachable",
  "first-connection",
  "empty",
  "too-small",
  "multi-host-overview",
  "remote-selected",
] as const;

export type TuiDesignScene = (typeof tuiDesignScenes)[number];

const LOCAL_HOST = "m5dev";
const REMOTE_HOST = "this-mac";
const WIDE_ALIAS = "codex-資料-e\u0301quipe-with-an-intentionally-long-name@m5dev";

const localEndpoints = [
  {
    id: "reg_busy_000000000000000000000001",
    alias: "codex-release-coordinator@m5dev",
    host: LOCAL_HOST,
    provider: "codex",
    queueDepth: 7,
    codex: { state: "busy" },
    lastOperation: { outcome: "delivered", code: "DELIVERED" },
  },
  {
    id: "reg_waiting_00000000000000000002",
    alias: "codex-needs-approval@m5dev",
    host: LOCAL_HOST,
    provider: "codex",
    queueDepth: 2,
    codex: { state: "waiting" },
    lastOperation: { outcome: "queued", code: "ROUTE_BUSY" },
  },
  {
    id: "reg_idle_000000000000000000000003",
    alias: WIDE_ALIAS,
    host: LOCAL_HOST,
    provider: "codex",
    queueDepth: 0,
    codex: { state: "idle" },
    lastOperation: { outcome: "delivered", code: "TRANSPORT_WRITTEN" },
  },
  {
    id: "reg_idle_collision_00000000000004",
    alias: WIDE_ALIAS,
    host: LOCAL_HOST,
    provider: "codex",
    queueDepth: 1,
    codex: { state: "idle" },
    lastOperation: { outcome: "failed", code: "REQUEST_TIMEOUT" },
  },
  {
    id: "reg_dormant_00000000000000000005",
    alias: "codex-overnight-audit@m5dev",
    host: LOCAL_HOST,
    provider: "codex",
    queueDepth: 0,
    codex: { state: "dormant" },
  },
  {
    id: "reg_unknown_00000000000000000006",
    alias: "embassy-pm@m5dev",
    host: LOCAL_HOST,
    provider: "claude",
    queueDepth: 0,
    lastOperation: { outcome: "delivered", code: "DELIVERED" },
  },
  {
    id: "reg_faulted_00000000000000000007",
    alias: "codex-provider-fault@m5dev",
    host: LOCAL_HOST,
    provider: "codex",
    queueDepth: 3,
    codex: { state: "systemError" },
    lastOperation: { outcome: "failed", code: "MANAGED_CODEX_UNAVAILABLE" },
  },
] as const;

const messages = [
  {
    token: "dlv_abcdefghijklmnopqrstuvwx",
    source: "codex-release-coordinator@m5dev",
    target: "embassy-pm@m5dev",
    state: "delivered",
    ageMs: 1_250,
    safeErrorCode: "DELIVERED",
  },
  {
    token: "dlv_zyxwvutsrqponmlkjihgfedc",
    source: "embassy-pm@m5dev",
    target: "codex-needs-approval@m5dev",
    state: "failed",
    ageMs: 48_000,
    safeErrorCode: "REQUEST_TIMEOUT",
  },
  {
    token: "dlv_000000000000000000000000",
    source: "codex-release-coordinator@m5dev",
    target: "codex-remote-check@this-mac",
    state: "queued",
    ageMs: 92_000,
    safeErrorCode: "ROUTE_BUSY",
  },
  { token: "dlv_111111111111111111111111", state: "delivered", ageMs: 180_000 },
  { token: "dlv_222222222222222222222222", state: "unconfirmed", ageMs: 181_000, safeErrorCode: "REQUEST_TIMEOUT" },
] as const;

const retirements = [
  { alias: "codex-old-release@m5dev", at: "2026-09-06T18:20:00.000Z", provider: "codex" },
  { alias: "loopback-a-1234abcd@m5dev", at: "2026-09-06T17:30:00.000Z", provider: "codex" },
  { alias: "peer-retired-shell@m5dev", at: "2026-09-05T18:30:00.000Z", provider: "peer" },
] as const;

const remoteRoutes = [
  {
    id: "reg_remote_000000000000000000001",
    alias: "codex-remote-check@this-mac",
    host: REMOTE_HOST,
    provider: "codex",
  },
  {
    id: "reg_remote_000000000000000000002",
    alias: "embassy-pm@this-mac",
    host: REMOTE_HOST,
    provider: "claude",
  },
] as const;

const healthySnapshot = {
  health: "healthy",
  revision: 184,
  routes: localEndpoints,
  messages,
  retirements,
  codex: {
    complete: true,
    truncated: false,
    observedAt: "2026-09-06T18:29:58.000Z",
  },
  federation: {
    truncated: false,
    nodes: [{
      host: REMOTE_HOST,
      observedAt: "2026-09-06T18:29:54.000Z",
      routes: remoteRoutes,
    }],
  },
};

const selection = (section: Section = "endpoints") => ({
  section,
  selected: { endpoints: 0, deliveries: 0, retirements: 0, result: 0 },
  mode: "browse" as const,
  token: "",
});

function base(section: Section = "endpoints"): TuiModel {
  return {
    ...selection(section),
    snapshot: healthySnapshot,
    snapshotAt: FIXED_TUI_NOW - 800,
    host: LOCAL_HOST,
  };
}

function endpointForConfirmation(): EndpointRow {
  const endpoint = localEndpoints[0];
  return { ...endpoint, local: true };
}

export const defaultTuiSceneSize: Readonly<Record<TuiDesignScene, readonly [number, number]>> = {
  endpoints: [140, 45],
  deliveries: [100, 30],
  retirements: [100, 30],
  result: [100, 30],
  "retirement-confirm": [100, 30],
  token: [80, 24],
  "stale-unreachable": [100, 30],
  "first-connection": [80, 24],
  empty: [80, 24],
  "too-small": [40, 9],
  "multi-host-overview": [140, 45],
  "remote-selected": [100, 30],
};

export function tuiDesignFixture(scene: TuiDesignScene): TuiModel {
  if (scene === "endpoints") return base();
  if (scene === "deliveries") return base("deliveries");
  if (scene === "retirements") return base("retirements");
  if (scene === "result") return {
    ...base("result"),
    previousSection: "deliveries",
    result: {
      label: "delivery dlv_abcdefghijklmnopqrstuvwx",
      value: JSON.stringify({ found: true, state: "delivered", terminal: true, safeErrorCode: "DELIVERED" }),
    },
  };
  if (scene === "retirement-confirm") return {
    ...base(),
    mode: "confirm",
    retiring: endpointForConfirmation(),
    selectedEndpoint: `${LOCAL_HOST}\0${localEndpoints[0].id}`,
  };
  if (scene === "token") return {
    ...base("deliveries"),
    mode: "token",
    token: "dlv_abcdefghijklmnop",
  };
  if (scene === "stale-unreachable") return {
    ...base(),
    snapshot: { ...healthySnapshot, routes: remoteRoutes.map((route) => ({ ...route, queueDepth: 0 })),
      federation: { truncated: false, nodes: [] } },
    snapshotAt: FIXED_TUI_NOW - 47_000,
    staleSince: FIXED_TUI_NOW - 45_000,
    error: "PEER_TUNNEL_UNAVAILABLE",
    errorDetail: "remote CLI metadata: version 4.2.0 is unsupported",
    hosts: [
      { host: LOCAL_HOST, state: "healthy", selected: false },
      { host: REMOTE_HOST, state: "unreachable", selected: true },
    ],
    host: REMOTE_HOST,
  };
  if (scene === "first-connection") return {
    ...selection(),
    host: LOCAL_HOST,
  };
  if (scene === "empty") return {
    ...base(),
    snapshot: {
      health: "healthy",
      revision: 1,
      routes: [],
      messages: [],
      retirements: [],
      codex: { complete: true, truncated: false, observedAt: "2026-09-06T18:29:59.000Z" },
      federation: { truncated: false, nodes: [] },
    },
  };
  if (scene === "too-small") return base();
  if (scene === "multi-host-overview") return {
    ...base(),
    snapshot: { ...healthySnapshot, federation: { truncated: false, nodes: [] } },
    hosts: [
      { host: LOCAL_HOST, state: "healthy", selected: true },
      { host: REMOTE_HOST, state: "stale", selected: false },
      { host: "lab-node", state: "unreachable", selected: false },
    ],
  };
  return {
    ...base(),
    snapshot: {
      ...healthySnapshot,
      revision: 92,
      routes: remoteRoutes.map((route, index) => ({
        ...route,
        queueDepth: index,
        codex: route.provider === "codex" ? { state: "idle" } : undefined,
      })),
      federation: { truncated: false, nodes: [] },
    },
    host: REMOTE_HOST,
    hosts: [
      { host: LOCAL_HOST, state: "healthy", selected: false },
      { host: REMOTE_HOST, state: "healthy", selected: true },
    ],
    selectedEndpoint: `${REMOTE_HOST}\0${remoteRoutes[0].id}`,
  };
}

export function isTuiDesignScene(value: string): value is TuiDesignScene {
  return (tuiDesignScenes as readonly string[]).includes(value);
}
