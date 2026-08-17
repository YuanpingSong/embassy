import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  open,
  realpath,
  rename as renameFile,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { BridgeError } from "../errors.js";
import { isGatewayPersistedStateV3 } from "./store.js";
import type {
  GatewayConsentEdgeRecord,
  GatewayMessageRecord,
  GatewayPersistedState,
  GatewayProvider,
  GatewayRouteRecord,
  MessageDirection,
  NormalizedMessageEvent,
  RouteCounters,
} from "./types.js";

const STATE_MARKER = ".agent-embassy-state";
const STATE_MARKER_BODY = "agent-embassy-state-v1\n";
const STATE_FILE = "gateway-state.json";
const BACKUP_FILE = "gateway-state.v2.backup.json";
const CONTROLLER_LOCK = ".gateway-controller.lock";
const MAX_STATE_BYTES = 8 * 1024 * 1024;
const MAX_MARKER_BYTES = 128;
const MAX_LOCK_BYTES = 4 * 1024;
const PROVIDERS = new Set(["claude", "codex", "deepseek", "grok"]);
const ROUTE_STATES = new Set([
  "stale", "idle", "busy", "awaiting_approval", "offline", "disabled",
]);
const REGISTRATION_MODES = new Set(["explicit_opt_in", "selected_live_peer"]);
const CONNECTOR_HEALTH = new Set(["offline", "connecting", "healthy", "degraded"]);
const DELIVERY_STATES = new Set([
  "queued", "duplicate", "dispatching", "transport_written", "held",
  "delivered", "unconfirmed", "failed", "ambiguous", "expired",
  "cancelled", "abandoned", "rejected",
]);
const ALIAS = /^[a-z][a-z0-9_-]{0,31}@[a-z0-9](?:[a-z0-9.-]{0,61}[a-z0-9])?$/;
const HOST = /^[a-z0-9](?:[a-z0-9.-]{0,61}[a-z0-9])?$/;
const PRIVATE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const SAFE_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const MESSAGE_ID = /^msg_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MESSAGE_SUFFIX = /^[0-9a-f]{8}$/;
const CONVERSATION_SUFFIX = /^[A-Za-z0-9_-]{8}$/;
const FINGERPRINT = /^[A-Za-z0-9_-]{43}$/;
const PROTOCOL = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const PROTOCOL_VERSION = /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,63}$/;
const INGRESS_PREFIX: Readonly<Record<GatewayProvider, string | undefined>> = {
  claude: undefined,
  codex: "codex-",
  deepseek: "dsh-",
  grok: "grok-",
};

export const gatewayStateV2ToV3FaultStages = [
  "before_backup_write",
  "before_backup_file_sync",
  "before_backup_directory_sync",
  "before_backup_readback",
  "before_target_write",
  "before_target_file_sync",
  "before_target_rename",
  "after_target_rename",
  "before_target_directory_sync",
  "before_target_readback",
] as const;

export type GatewayStateV2ToV3FaultStage =
  (typeof gatewayStateV2ToV3FaultStages)[number];

export type GatewayStateV2ToV3Dependencies = Readonly<{
  fault?: (stage: GatewayStateV2ToV3FaultStage) => void | Promise<void>;
  now?: () => Date;
  randomId?: () => string;
  renameState?: (source: string, target: string) => Promise<void>;
}>;

export type GatewayStateV2ToV3Result = Readonly<{
  /** Safe for normalized CLI output; contains no native or route identity. */
  backupFile: string;
  /** Internal readback correlation. Public surfaces must never print it. */
  commitId: string;
  commitSequence: number;
}>;

type JsonRecord = Record<string, unknown>;

type V2Binding = Readonly<{
  provider: GatewayProvider;
  hostId: string;
  endpointGeneration: string;
  routeHandle: string;
  ownerLease: string;
}>;

type V2Route = Readonly<{
  alias: string;
  binding: V2Binding;
  registrationMode: "explicit_opt_in" | "selected_live_peer";
  enabled: boolean;
  state: string;
  busyPolicy: "queue";
  registeredAt: string;
  updatedAt: string;
  lastSeenAt?: string;
  queueDepth: number;
  counters: RouteCounters;
  safeErrorCode?: string;
}>;

type V2ConsentEndpoint = Readonly<{
  alias: string;
  provider: GatewayProvider;
  ownerLease: string;
}>;

type V2ConsentEdge = Readonly<{
  endpoints: readonly [V2ConsentEndpoint, V2ConsentEndpoint];
  createdAt: string;
  updatedAt: string;
  counters: RouteCounters;
}>;

type V2QueuedMessage = Readonly<{
  messageId: string;
  messageIdSuffix: string;
  conversationIdSuffix?: string;
  direction: MessageDirection;
  sourceAlias: string;
  targetAlias: string;
  enqueuedAt: string;
  deadlineAt: string;
  bytes: number;
  body?: string;
  pair?: true;
  transientTarget?: true;
  steer?: true;
}>;

type V2InFlightMessage = V2QueuedMessage & Readonly<{ dispatchedAt: string }>;

type V2State = Readonly<{
  schemaVersion: 2;
  createdAt: string;
  updatedAt: string;
  eventSequence: number;
  routes: readonly V2Route[];
  consentEdges: readonly V2ConsentEdge[];
  connectors: readonly JsonRecord[];
  queue: readonly V2QueuedMessage[];
  inFlight: readonly V2InFlightMessage[];
  events: readonly NormalizedMessageEvent[];
  dedupe: GatewayPersistedState["dedupe"];
  rateBuckets: GatewayPersistedState["rateBuckets"];
  accounting: GatewayPersistedState["accounting"];
  watchSequence: number;
  progressWatches: readonly JsonRecord[];
  progressWatchEvents: readonly JsonRecord[];
  codexEndpointRefreshSequence: number;
  codexEndpointRefreshEvents: readonly JsonRecord[];
  codexOrphanRemovalSequence: number;
  codexOrphanRemovalEvents: readonly JsonRecord[];
  codexSuccession: JsonRecord | null;
}>;

class ConversionCommitError extends BridgeError {
  constructor(verified: boolean) {
    super(
      "GATEWAY_STATE_COMMIT_OUTCOME_UNKNOWN",
      verified
        ? "The v3 state rename was installed and read back exactly, but its directory durability was not confirmed; retry is forbidden."
        : "The v3 state rename crossed the commit point but exact readback failed; retry and automatic rollback are forbidden.",
      false,
    );
  }
}

/**
 * One-shot release-owned offline conversion. Callers must resolve the normal
 * configured state directory before entering; this API never starts providers,
 * helpers, discovery, the control socket, or the broker runtime.
 */
export async function convertGatewayStateV2ToV3(
  options: Readonly<{ stateDir: string }>,
  dependencies: GatewayStateV2ToV3Dependencies = {},
): Promise<GatewayStateV2ToV3Result> {
  const now = dependencies.now ?? (() => new Date());
  const randomId = dependencies.randomId ?? randomUUID;
  const fault = dependencies.fault ?? (() => undefined);
  const renameState = dependencies.renameState ?? renameFile;
  const root = await validateStateRoot(options.stateDir);
  const marker = await readPrivateFile(
    path.join(root, STATE_MARKER),
    MAX_MARKER_BYTES,
  );
  if (marker.toString("utf8") !== STATE_MARKER_BODY) {
    throw conversionError(
      "GATEWAY_STATE_DIRECTORY_NOT_OWNED",
      "The gateway state ownership marker is not recognized.",
    );
  }

  const lock = await acquireOfflineLock(root, nextRandomId(randomId));
  try {
    const statePath = path.join(root, STATE_FILE);
    const source = await readPrivateFile(statePath, MAX_STATE_BYTES);
    const v2 = decodeGatewayStateV2(source);
    if (v2.codexSuccession !== null) {
      throw conversionError(
        "GATEWAY_STATE_CONVERSION_SUCCESSION_ACTIVE",
        "State conversion requires the Codex succession journal to be inactive.",
      );
    }
    const converted = convertState(v2, now(), nextRandomId(randomId));
    if (!isGatewayPersistedStateV3(converted)) {
      throw conversionError(
        "CORRUPT_GATEWAY_STATE",
        "The strict v2 state could not be represented as valid native v3 state.",
      );
    }
    const body = Buffer.from(`${JSON.stringify(converted, null, 2)}\n`, "utf8");
    if (body.byteLength > MAX_STATE_BYTES) {
      throw conversionError(
        "GATEWAY_STATE_FILE_TOO_LARGE",
        "The converted native state exceeds its strict byte limit.",
      );
    }

    const backupPath = path.join(root, BACKUP_FILE);
    await writeExclusivePrivateFile(
      backupPath,
      source,
      "backup",
      fault,
    );
    await fault("before_backup_directory_sync");
    await syncDirectory(root);
    await fault("before_backup_readback");
    const backup = await readPrivateFile(backupPath, MAX_STATE_BYTES);
    if (
      !backup.equals(source) ||
      sha256(backup) !== sha256(source)
    ) {
      throw conversionError(
        "GATEWAY_STATE_BACKUP_MISMATCH",
        "The byte-identical v2 backup could not be verified; the target was not mutated.",
      );
    }

    const temporary = path.join(root, `.gateway-state-v3-${nextRandomId(randomId)}.tmp`);
    let temporaryHandle: FileHandle | undefined;
    let renamed = false;
    try {
      temporaryHandle = await openExclusivePrivate(temporary);
      await fault("before_target_write");
      await temporaryHandle.writeFile(body);
      await temporaryHandle.chmod(0o600);
      await fault("before_target_file_sync");
      await temporaryHandle.sync();
      await temporaryHandle.close();
      temporaryHandle = undefined;

      // The converter owns the ordinary controller lock, but re-read the
      // source immediately before rename so an uncooperative writer cannot be
      // overwritten using stale evidence.
      await fault("before_target_rename");
      const current = await readPrivateFile(statePath, MAX_STATE_BYTES);
      if (!current.equals(source) || sha256(current) !== sha256(source)) {
        throw conversionError(
          "GATEWAY_STATE_SOURCE_CHANGED",
          "The v2 source changed after backup verification; conversion was not installed.",
        );
      }
      try {
        await renameState(temporary, statePath);
        renamed = true;
      } catch (renameError) {
        const outcome = await reconcileRenameError(statePath, source, body, converted);
        if (outcome === "source") throw renameError;
        if (outcome === "unknown") throw new ConversionCommitError(false);
        renamed = true;
      }
      await fault("after_target_rename");
      await fault("before_target_directory_sync");
      await syncDirectory(root);
      await fault("before_target_readback");
      const installed = await readPrivateFile(statePath, MAX_STATE_BYTES);
      const parsed = parseJson(installed);
      if (
        !installed.equals(body) ||
        !isGatewayPersistedStateV3(parsed) ||
        parsed.commit.id !== converted.commit.id ||
        parsed.commit.sequence !== converted.commit.sequence
      ) {
        throw new ConversionCommitError(false);
      }
    } catch (error) {
      if (!renamed) throw error;
      let verified = false;
      try {
        const installed = await readPrivateFile(statePath, MAX_STATE_BYTES);
        const parsed = parseJson(installed);
        verified =
          installed.equals(body) &&
          isGatewayPersistedStateV3(parsed) &&
          parsed.commit.id === converted.commit.id &&
          parsed.commit.sequence === converted.commit.sequence;
      } catch {
        // Crossing rename forbids automatic rollback even when readback fails.
      }
      if (error instanceof ConversionCommitError) throw error;
      throw new ConversionCommitError(verified);
    } finally {
      await temporaryHandle?.close().catch(() => undefined);
      if (!renamed) await unlink(temporary).catch(() => undefined);
    }

    return {
      backupFile: BACKUP_FILE,
      commitId: converted.commit.id,
      commitSequence: converted.commit.sequence,
    };
  } finally {
    await releaseOfflineLock(root, lock);
  }
}

function convertState(v2: V2State, convertedAt: Date, commitId: string): GatewayPersistedState {
  const timestamp = convertedAt.toISOString();
  const routes = v2.routes.map<GatewayRouteRecord>((route) => ({
    alias: route.alias,
    binding: {
      provider: route.binding.provider,
      hostId: route.binding.hostId,
      routeHandle: route.binding.routeHandle,
      registrationId: route.binding.ownerLease,
    },
    registrationMode: route.registrationMode,
    enabled: route.enabled,
    busyPolicy: route.busyPolicy,
    registeredAt: route.registeredAt,
    updatedAt: route.updatedAt,
    counters: { ...route.counters },
  }));
  const routeByAlias = new Map(routes.map((route) => [route.alias, route]));
  const consentEdges = v2.consentEdges.map<GatewayConsentEdgeRecord>((edge) => ({
    endpoints: edge.endpoints.map((endpoint) => ({
      alias: endpoint.alias,
      provider: endpoint.provider,
      registrationId: endpoint.ownerLease,
    })) as unknown as GatewayConsentEdgeRecord["endpoints"],
    createdAt: edge.createdAt,
    updatedAt: edge.updatedAt,
    counters: { ...edge.counters },
  }));

  let nextSequence = v2.eventSequence;
  const message = (
    item: V2QueuedMessage,
    state: GatewayMessageRecord["state"],
  ): GatewayMessageRecord => {
    const source = routeByAlias.get(item.sourceAlias);
    const target = routeByAlias.get(item.targetAlias);
    const edge = item.pair === true
      ? consentEdges.find((candidate) =>
          candidate.endpoints.some((endpoint) => endpoint.alias === item.sourceAlias) &&
          candidate.endpoints.some((endpoint) => endpoint.alias === item.targetAlias))
      : undefined;
    return {
      sequence: ++nextSequence,
      messageId: item.messageId,
      messageIdSuffix: item.messageIdSuffix,
      ...(item.conversationIdSuffix === undefined ? {} : { conversationIdSuffix: item.conversationIdSuffix }),
      direction: item.direction,
      sourceAlias: item.sourceAlias,
      targetAlias: item.targetAlias,
      enqueuedAt: item.enqueuedAt,
      deadlineAt: item.deadlineAt,
      bytes: item.bytes,
      ...(item.body === undefined ? {} : { body: item.body }),
      ...(item.pair === true ? { pair: true as const } : {}),
      ...(item.transientTarget === true ? { transientTarget: true as const } : {}),
      ...(item.steer === true ? { steer: true as const } : {}),
      sourceRegistrationId: source?.binding.registrationId ?? null,
      targetRegistrationId: target?.binding.registrationId ?? null,
      consentEdge: edge?.endpoints ?? null,
      state,
    };
  };

  const messages: GatewayMessageRecord[] = [];
  const accounting = { ...v2.accounting };
  const recordTerminal = (
    item: V2QueuedMessage,
    outcome: "ambiguous" | "expired" | "abandoned",
  ): void => {
    accounting[outcome] += 1;
    const target = routeByAlias.get(item.targetAlias);
    if (target !== undefined) target.counters[outcome] += 1;
    if (item.pair === true) {
      const edge = consentEdges.find((candidate) =>
        candidate.endpoints.some((endpoint) => endpoint.alias === item.sourceAlias) &&
        candidate.endpoints.some((endpoint) => endpoint.alias === item.targetAlias));
      if (edge !== undefined) {
        edge.counters[outcome] += 1;
        edge.updatedAt = timestamp;
      }
    }
  };
  for (const item of v2.queue) {
    const expired = Date.parse(item.deadlineAt) <= convertedAt.getTime();
    const targetMissing = !routeByAlias.has(item.targetAlias);
    const terminal = expired || targetMissing || item.body === undefined || item.transientTarget === true;
    const outcome = expired ? "expired" : "abandoned";
    const record = message(
      item,
      terminal
        ? {
            phase: "terminal",
            outcome,
            terminalAt: timestamp,
            safeErrorCode: expired ? "MESSAGE_EXPIRED" : "CONTROLLER_RESTARTED",
            latencyMs: Math.max(0, convertedAt.getTime() - Date.parse(item.enqueuedAt)),
          }
        : { phase: "queued", attemptCount: 0 },
    );
    messages.push(record);
    if (terminal) recordTerminal(item, outcome);
  }
  for (const item of v2.inFlight) {
    const record = message(item, {
      phase: "terminal",
      outcome: "ambiguous",
      terminalAt: timestamp,
      safeErrorCode: "CONTROLLER_RESTARTED",
      latencyMs: Math.max(0, convertedAt.getTime() - Date.parse(item.enqueuedAt)),
    });
    messages.push(record);
    recordTerminal(item, "ambiguous");
  }
  const queuedBytes = messages.reduce(
    (total, item) => total + (item.state.phase === "queued" ? item.bytes : 0),
    0,
  );
  const activity = v2.events.map((event) => ({
    type: "legacy_message" as const,
    event: { ...event },
  }));
  return {
    schemaVersion: 3,
    commit: { sequence: 0, id: commitId },
    createdAt: v2.createdAt,
    updatedAt: timestamp,
    eventSequence: nextSequence,
    routes,
    consentEdges,
    messages,
    dedupe: v2.dedupe.map((record) => ({ ...record })),
    rateBuckets: v2.rateBuckets.map((bucket) => ({ ...bucket })),
    activity,
    accounting: { ...accounting, queuedBytes },
  };
}

function decodeGatewayStateV2(body: Buffer): V2State {
  const value = parseJson(body);
  if (isGatewayPersistedStateV3(value)) {
    throw conversionError(
      "GATEWAY_STATE_CONVERSION_ALREADY_APPLIED",
      "The gateway state is already native schema v3; a second conversion is forbidden.",
    );
  }
  if (!isV2State(value)) {
    throw conversionError(
      "CORRUPT_GATEWAY_STATE",
      "The offline converter requires one strict, internally consistent native v2 state file.",
    );
  }
  if (value.codexSuccession !== null) {
    throw conversionError(
      "GATEWAY_STATE_CONVERSION_SUCCESSION_ACTIVE",
      "State conversion requires the Codex succession journal to be inactive.",
    );
  }
  return value as V2State;
}

async function reconcileRenameError(
  statePath: string,
  source: Buffer,
  body: Buffer,
  converted: GatewayPersistedState,
): Promise<"installed" | "source" | "unknown"> {
  try {
    const current = await readPrivateFile(statePath, MAX_STATE_BYTES);
    if (current.equals(source) && sha256(current) === sha256(source)) return "source";
    if (!current.equals(body)) return "unknown";
    const parsed = parseJson(current);
    return isGatewayPersistedStateV3(parsed) &&
      parsed.commit.id === converted.commit.id &&
      parsed.commit.sequence === converted.commit.sequence
      ? "installed"
      : "unknown";
  } catch {
    return "unknown";
  }
}

function parseJson(body: Buffer): unknown {
  try {
    return JSON.parse(body.toString("utf8")) as unknown;
  } catch {
    throw conversionError(
      "CORRUPT_GATEWAY_STATE",
      "The gateway state is not strict JSON.",
    );
  }
}

function isV2State(value: unknown): value is V2State {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "schemaVersion", "createdAt", "updatedAt", "eventSequence", "routes",
      "consentEdges", "connectors", "queue", "inFlight", "events", "dedupe",
      "rateBuckets", "accounting", "watchSequence", "progressWatches",
      "progressWatchEvents", "codexEndpointRefreshSequence",
      "codexEndpointRefreshEvents", "codexOrphanRemovalSequence",
      "codexOrphanRemovalEvents", "codexSuccession",
    ]) ||
    value.schemaVersion !== 2 ||
    !iso(value.createdAt) ||
    !iso(value.updatedAt) ||
    !nonNegativeInteger(value.eventSequence) ||
    !nonNegativeInteger(value.watchSequence) ||
    !nonNegativeInteger(value.codexEndpointRefreshSequence) ||
    !nonNegativeInteger(value.codexOrphanRemovalSequence) ||
    !Array.isArray(value.routes) || !value.routes.every(isV2Route) ||
    !Array.isArray(value.consentEdges) || value.consentEdges.length > 256 ||
    !value.consentEdges.every(isV2ConsentEdge) ||
    !Array.isArray(value.connectors) || !value.connectors.every(isV2Connector) ||
    !Array.isArray(value.queue) || !value.queue.every(isV2QueuedMessage) ||
    !Array.isArray(value.inFlight) || !value.inFlight.every(isV2InFlightMessage) ||
    !Array.isArray(value.events) || value.events.length > 1_024 ||
    !value.events.every(isV2Event) ||
    !Array.isArray(value.dedupe) || !value.dedupe.every(isV2Dedupe) ||
    !Array.isArray(value.rateBuckets) || !value.rateBuckets.every(isV2RateBucket) ||
    !isCounters(value.accounting, true) ||
    !Array.isArray(value.progressWatches) || value.progressWatches.length > 256 ||
    !value.progressWatches.every(isV2ProgressWatch) ||
    !Array.isArray(value.progressWatchEvents) || value.progressWatchEvents.length > 1_024 ||
    !value.progressWatchEvents.every(isV2ProgressWatchEvent) ||
    !Array.isArray(value.codexEndpointRefreshEvents) ||
    value.codexEndpointRefreshEvents.length > 256 ||
    !value.codexEndpointRefreshEvents.every(isV2EndpointRefreshEvent) ||
    !Array.isArray(value.codexOrphanRemovalEvents) ||
    value.codexOrphanRemovalEvents.length > 256 ||
    !value.codexOrphanRemovalEvents.every(isV2OrphanEvent) ||
    (value.codexSuccession !== null && !isV2CodexSuccession(value.codexSuccession))
  ) return false;

  // The active journal is deliberately refused rather than interpreted by the
  // converter. Validate the rest of the graph before returning that safe code.
  const routes = value.routes as V2Route[];
  const edges = value.consentEdges as V2ConsentEdge[];
  const queue = value.queue as V2QueuedMessage[];
  const inFlight = value.inFlight as V2InFlightMessage[];
  const aliases = new Set(routes.map((route) => route.alias));
  const leases = new Set(routes.map((route) => route.binding.ownerLease));
  const targets = new Set(routes.map((route) =>
    `${route.binding.provider}\0${route.binding.hostId}\0${route.binding.endpointGeneration}\0${route.binding.routeHandle}`));
  const routeByAlias = new Map(routes.map((route) => [route.alias, route]));
  const edgeKeys = edges.map((edge) => edge.endpoints
    .map((endpoint) => `${endpoint.provider}\0${endpoint.alias}\0${endpoint.ownerLease}`)
    .join("\0"));
  const messageIds = [...queue, ...inFlight].map((item) => item.messageId);
  const expectedQueuedBytes = queue.reduce((total, item) => total + item.bytes, 0);
  const connectors = value.connectors as JsonRecord[];
  const events = value.events as NormalizedMessageEvent[];
  const progressEvents = value.progressWatchEvents as JsonRecord[];
  const refreshEvents = value.codexEndpointRefreshEvents as JsonRecord[];
  const orphanEvents = value.codexOrphanRemovalEvents as JsonRecord[];
  const watches = value.progressWatches as JsonRecord[];
  if (
    aliases.size !== routes.length ||
    leases.size !== routes.length ||
    targets.size !== routes.length ||
    new Set(edgeKeys).size !== edges.length ||
    new Set(messageIds).size !== messageIds.length ||
    new Set(connectors.map((item) => `${item.provider}\0${item.hostId}`)).size !== connectors.length ||
    new Set((value.dedupe as JsonRecord[]).map((item) => item.fingerprint)).size !== value.dedupe.length ||
    new Set((value.rateBuckets as JsonRecord[]).map((item) => item.sourceAlias)).size !== value.rateBuckets.length ||
    new Set(watches.map((watch) => watch.conversationId)).size !== watches.length ||
    new Set(watches.map(v2ProgressWatchPairKey)).size !== watches.length ||
    (value.accounting as JsonRecord).queuedBytes !== expectedQueuedBytes
  ) return false;
  for (const edge of edges) {
    const [left, right] = edge.endpoints;
    const leftRoute = routeByAlias.get(left.alias);
    const rightRoute = routeByAlias.get(right.alias);
    if (
      leftRoute?.binding.provider !== left.provider ||
      rightRoute?.binding.provider !== right.provider ||
      leftRoute.binding.ownerLease !== left.ownerLease ||
      rightRoute.binding.ownerLease !== right.ownerLease ||
      left.provider === right.provider ||
      leftRoute.binding.hostId !== rightRoute.binding.hostId ||
      compareV2Endpoints(left, right) >= 0
    ) return false;
  }
  for (const route of routes) {
    if (
      !route.alias.endsWith(`@${route.binding.hostId}`) ||
      (route.binding.provider === "claude") !==
        (route.registrationMode === "selected_live_peer") ||
      (INGRESS_PREFIX[route.binding.provider] !== undefined &&
        !route.alias.startsWith(INGRESS_PREFIX[route.binding.provider]!)) ||
      route.queueDepth !== queue.filter((item) => item.targetAlias === route.alias).length
    ) return false;
  }
  for (const watch of watches) {
    const owner = routeByAlias.get(String(watch.ownerAlias));
    const worker = routeByAlias.get(String(watch.workerAlias));
    if (
      owner === undefined || worker === undefined ||
      owner.binding.ownerLease !== watch.ownerLease ||
      worker.binding.ownerLease !== watch.workerLease ||
      owner.binding.provider === worker.binding.provider ||
      owner.binding.hostId !== worker.binding.hostId
    ) return false;
    const expected = [owner, worker]
      .map((route) => ({
        alias: route.alias,
        provider: route.binding.provider,
        ownerLease: route.binding.ownerLease,
      }))
      .sort(compareV2Endpoints);
    if (!edges.some((edge) => edge.endpoints.every((endpoint, index) =>
      endpoint.alias === expected[index]!.alias &&
      endpoint.provider === expected[index]!.provider &&
      endpoint.ownerLease === expected[index]!.ownerLease))) return false;
  }
  const messageGraphValid = [...queue, ...inFlight].every((item) => {
    const separator = item.direction.indexOf("_to_");
    const sourceProvider = item.direction.slice(0, separator);
    const targetProvider = item.direction.slice(separator + 4);
    const source = routeByAlias.get(item.sourceAlias);
    const target = routeByAlias.get(item.targetAlias);
    const claudeHosts = new Set(connectors
      .filter((connector) => connector.provider === "claude")
      .map((connector) => connector.hostId));
    const sourceValid = source?.binding.provider === sourceProvider ||
      (source === undefined && sourceProvider === "claude" && target !== undefined &&
        claudeHosts.has(target.binding.hostId) && aliasHost(item.sourceAlias) === target.binding.hostId);
    const targetValid = target?.binding.provider === targetProvider ||
      (target === undefined && targetProvider === "claude" && source !== undefined &&
        claudeHosts.has(source.binding.hostId) && aliasHost(item.targetAlias) === source.binding.hostId);
    const consentValid = item.pair !== true || edges.some((edge) =>
      edge.endpoints.some((endpoint) => endpoint.alias === item.sourceAlias) &&
      edge.endpoints.some((endpoint) => endpoint.alias === item.targetAlias));
    return item.messageIdSuffix === item.messageId.replaceAll("-", "").slice(-8).toLowerCase() &&
      sourceValid && targetValid && consentValid &&
      (source === undefined || target === undefined || source.binding.hostId === target.binding.hostId);
  });
  const metadataGraphValid = (value.dedupe as JsonRecord[]).every((item) => {
    const separator = String(item.direction).indexOf("_to_");
    const sourceProvider = String(item.direction).slice(0, separator);
    const targetProvider = String(item.direction).slice(separator + 4);
    const source = routeByAlias.get(String(item.sourceAlias));
    const target = routeByAlias.get(String(item.targetAlias));
    const claudeHosts = new Set(connectors
      .filter((connector) => connector.provider === "claude")
      .map((connector) => connector.hostId));
    const sourceValid = source?.binding.provider === sourceProvider ||
      (source === undefined && sourceProvider === "claude" && target !== undefined &&
        claudeHosts.has(target.binding.hostId) && aliasHost(String(item.sourceAlias)) === target.binding.hostId);
    const targetValid = target?.binding.provider === targetProvider ||
      (target === undefined && targetProvider === "claude" && source !== undefined &&
        claudeHosts.has(source.binding.hostId) && aliasHost(String(item.targetAlias)) === source.binding.hostId);
    const consentValid = item.pair !== true || edges.some((edge) =>
      edge.endpoints.some((endpoint) => endpoint.alias === item.sourceAlias) &&
      edge.endpoints.some((endpoint) => endpoint.alias === item.targetAlias));
    return sourceValid && targetValid && consentValid &&
      (source === undefined || target === undefined || source.binding.hostId === target.binding.hostId);
  });
  const rateGraphValid = (value.rateBuckets as JsonRecord[]).every((bucket) => {
    const alias = String(bucket.sourceAlias);
    if (routeByAlias.has(alias)) return true;
    const host = aliasHost(alias);
    return connectors.some((connector) =>
      connector.provider === "claude" && connector.hostId === host) &&
      routes.some((route) => route.binding.hostId === host);
  });
  const strictSequence = (items: readonly JsonRecord[], ceiling: number): boolean =>
    items.every((item, index) =>
      typeof item.sequence === "number" && item.sequence <= ceiling &&
      (index === 0 || item.sequence > Number(items[index - 1]!.sequence)));
  const contiguousJournal = (items: readonly JsonRecord[], sequence: number): boolean =>
    items.length === 0
      ? sequence === 0
      : items.at(-1)?.sequence === sequence && items.every((item, index) =>
          index === 0 || item.sequence === Number(items[index - 1]!.sequence) + 1);
  return messageGraphValid && metadataGraphValid && rateGraphValid &&
    strictSequence(events as unknown as JsonRecord[], value.eventSequence) &&
    strictSequence(progressEvents, value.watchSequence) &&
    contiguousJournal(refreshEvents, value.codexEndpointRefreshSequence) &&
    contiguousJournal(orphanEvents, value.codexOrphanRemovalSequence) &&
    isV2SuccessionConsistent(value as V2State);
}

function isV2Route(value: unknown): value is V2Route {
  if (!isRecord(value) || !exactKeys(value,
    ["alias", "binding", "registrationMode", "enabled", "state", "busyPolicy", "registeredAt", "updatedAt", "queueDepth", "counters"],
    ["lastSeenAt", "safeErrorCode"])) return false;
  return typeof value.alias === "string" && ALIAS.test(value.alias) &&
    isV2Binding(value.binding) && typeof value.registrationMode === "string" &&
    REGISTRATION_MODES.has(value.registrationMode) && typeof value.enabled === "boolean" &&
    typeof value.state === "string" && ROUTE_STATES.has(value.state) &&
    value.busyPolicy === "queue" && iso(value.registeredAt) && iso(value.updatedAt) &&
    (value.lastSeenAt === undefined || iso(value.lastSeenAt)) &&
    nonNegativeInteger(value.queueDepth) && isCounters(value.counters) &&
    (value.safeErrorCode === undefined || safeCode(value.safeErrorCode));
}

function isV2Binding(value: unknown): value is V2Binding {
  return isRecord(value) && exactKeys(value,
    ["provider", "hostId", "endpointGeneration", "routeHandle", "ownerLease"]) &&
    provider(value.provider) && typeof value.hostId === "string" && HOST.test(value.hostId) &&
    token(value.endpointGeneration) && token(value.routeHandle) && token(value.ownerLease);
}

function isV2ConsentEndpoint(value: unknown): value is V2ConsentEndpoint {
  return isRecord(value) && exactKeys(value, ["alias", "provider", "ownerLease"]) &&
    typeof value.alias === "string" && ALIAS.test(value.alias) && provider(value.provider) &&
    token(value.ownerLease);
}

function isV2ConsentEdge(value: unknown): value is V2ConsentEdge {
  return isRecord(value) && exactKeys(value,
    ["endpoints", "createdAt", "updatedAt", "counters"]) &&
    Array.isArray(value.endpoints) && value.endpoints.length === 2 &&
    value.endpoints.every(isV2ConsentEndpoint) && iso(value.createdAt) &&
    iso(value.updatedAt) && isCounters(value.counters);
}

function isV2Connector(value: unknown): value is JsonRecord {
  return isRecord(value) && exactKeys(value,
    ["provider", "hostId", "endpointGeneration", "health", "protocol", "protocolVersion", "updatedAt"],
    ["lastSeenAt", "safeErrorCode"]) && provider(value.provider) &&
    typeof value.hostId === "string" && HOST.test(value.hostId) && token(value.endpointGeneration) &&
    typeof value.protocol === "string" && PROTOCOL.test(value.protocol) &&
    typeof value.protocolVersion === "string" && PROTOCOL_VERSION.test(value.protocolVersion) &&
    typeof value.health === "string" &&
    CONNECTOR_HEALTH.has(value.health) && iso(value.updatedAt) &&
    (value.lastSeenAt === undefined || iso(value.lastSeenAt)) &&
    (value.safeErrorCode === undefined || safeCode(value.safeErrorCode));
}

function isV2QueuedMessage(value: unknown): value is V2QueuedMessage {
  if (!isRecord(value) || !exactKeys(value,
    ["messageId", "messageIdSuffix", "direction", "sourceAlias", "targetAlias", "enqueuedAt", "deadlineAt", "bytes"],
    ["conversationIdSuffix", "body", "pair", "transientTarget", "steer"])) return false;
  return typeof value.messageId === "string" && MESSAGE_ID.test(value.messageId) &&
    typeof value.messageIdSuffix === "string" && MESSAGE_SUFFIX.test(value.messageIdSuffix) &&
    (value.conversationIdSuffix === undefined || (typeof value.conversationIdSuffix === "string" && CONVERSATION_SUFFIX.test(value.conversationIdSuffix))) &&
    direction(value.direction) && typeof value.sourceAlias === "string" && ALIAS.test(value.sourceAlias) &&
    typeof value.targetAlias === "string" && ALIAS.test(value.targetAlias) &&
    iso(value.enqueuedAt) && iso(value.deadlineAt) && positiveInteger(value.bytes) &&
    (value.body === undefined || (typeof value.body === "string" && value.body.length > 0 &&
      !value.body.includes("\0") && Buffer.byteLength(value.body, "utf8") === value.bytes)) &&
    (value.pair === undefined || value.pair === true) &&
    (value.transientTarget === undefined || value.transientTarget === true) &&
    (value.steer === undefined || value.steer === true);
}

function isV2InFlightMessage(value: unknown): value is V2InFlightMessage {
  if (!isRecord(value) || !iso(value.dispatchedAt)) return false;
  const { dispatchedAt: _ignored, ...queued } = value;
  return isV2QueuedMessage(queued);
}

function isV2Event(value: unknown): value is NormalizedMessageEvent {
  if (!isRecord(value) || !exactKeys(value,
    ["sequence", "timestamp", "messageIdSuffix", "direction", "sourceAlias", "targetAlias", "state", "bytes"],
    ["conversationIdSuffix", "body", "latencyMs", "safeErrorCode", "steer"])) return false;
  return positiveInteger(value.sequence) && iso(value.timestamp) &&
    typeof value.messageIdSuffix === "string" && MESSAGE_SUFFIX.test(value.messageIdSuffix) &&
    (value.conversationIdSuffix === undefined || (typeof value.conversationIdSuffix === "string" && CONVERSATION_SUFFIX.test(value.conversationIdSuffix))) &&
    direction(value.direction) && typeof value.sourceAlias === "string" && ALIAS.test(value.sourceAlias) &&
    typeof value.targetAlias === "string" && ALIAS.test(value.targetAlias) &&
    typeof value.state === "string" && DELIVERY_STATES.has(value.state) && positiveInteger(value.bytes) &&
    (value.body === undefined || (typeof value.body === "string" && value.body.length > 0 &&
      !value.body.includes("\0") && Buffer.byteLength(value.body, "utf8") === value.bytes)) &&
    (value.latencyMs === undefined || nonNegativeInteger(value.latencyMs)) &&
    (value.safeErrorCode === undefined || safeCode(value.safeErrorCode)) &&
    (value.steer === undefined || value.steer === true);
}

function isV2Dedupe(value: unknown): boolean {
  return isRecord(value) && exactKeys(value,
    ["fingerprint", "messageIdSuffix", "sourceAlias", "targetAlias", "direction", "firstSeenAt", "expiresAt"],
    ["conversationIdSuffix", "pair"]) && typeof value.fingerprint === "string" &&
    FINGERPRINT.test(value.fingerprint) && typeof value.messageIdSuffix === "string" &&
    MESSAGE_SUFFIX.test(value.messageIdSuffix) &&
    (value.conversationIdSuffix === undefined || (typeof value.conversationIdSuffix === "string" && CONVERSATION_SUFFIX.test(value.conversationIdSuffix))) &&
    typeof value.sourceAlias === "string" && ALIAS.test(value.sourceAlias) &&
    typeof value.targetAlias === "string" && ALIAS.test(value.targetAlias) && direction(value.direction) &&
    (value.pair === undefined || value.pair === true) && iso(value.firstSeenAt) && iso(value.expiresAt);
}

function isV2RateBucket(value: unknown): boolean {
  return isRecord(value) && exactKeys(value, ["sourceAlias", "windowStartedAt", "count"]) &&
    typeof value.sourceAlias === "string" && ALIAS.test(value.sourceAlias) &&
    iso(value.windowStartedAt) && nonNegativeInteger(value.count);
}

function isV2ProgressWatch(value: unknown): value is JsonRecord {
  if (!isRecord(value)) return false;
  const modern = exactKeys(value, [
    "conversationId", "ownerAlias", "workerAlias", "ownerLease", "workerLease",
    "lastActivityAt", "idleMs", "nudgeCount", "nextActionAt",
  ]);
  const legacy = exactKeys(value, [
    "conversationId", "ownerAlias", "workerAlias", "ownerLease", "workerLease",
    "createdAt", "updatedAt", "lastActivityAt", "idleMs", "phase", "nudgeCount",
    "nextActionAt", "capability", "degradedNoticeSent",
  ]);
  if (!modern && !legacy) return false;
  if (
    !conversationId(value.conversationId) ||
    typeof value.ownerAlias !== "string" || !ALIAS.test(value.ownerAlias) ||
    typeof value.workerAlias !== "string" || !ALIAS.test(value.workerAlias) ||
    value.ownerAlias === value.workerAlias || !token(value.ownerLease) ||
    !token(value.workerLease) || value.ownerLease === value.workerLease ||
    !iso(value.lastActivityAt) || !positiveInteger(value.idleMs) ||
    value.idleMs < 60_000 || value.idleMs > 86_400_000 ||
    ![0, 1, 2].includes(value.nudgeCount as number) || !iso(value.nextActionAt)
  ) return false;
  if (modern) return true;
  return iso(value.createdAt) && iso(value.updatedAt) &&
    (value.phase === "quiet" || value.phase === "episode") &&
    (value.phase === "quiet"
      ? value.nudgeCount === 0
      : value.nudgeCount === 1 || value.nudgeCount === 2) &&
    (value.capability === "conversation" || value.capability === "route") &&
    typeof value.degradedNoticeSent === "boolean";
}

function isV2ProgressWatchEvent(value: unknown): value is JsonRecord {
  if (!isRecord(value) || !positiveInteger(value.sequence) || !iso(value.timestamp) ||
    !conversationId(value.conversationId) || typeof value.ownerAlias !== "string" ||
    !ALIAS.test(value.ownerAlias) || typeof value.workerAlias !== "string" ||
    !ALIAS.test(value.workerAlias) || value.ownerAlias === value.workerAlias ||
    typeof value.kind !== "string") return false;
  if (exactKeys(value,
    ["sequence", "timestamp", "conversationId", "ownerAlias", "workerAlias", "kind", "actor"],
    ["reason"])) {
    if (value.kind === "opened") return value.actor === "owner" && value.reason === undefined;
    if (value.kind === "replaced") {
      return (value.actor === "owner" || value.actor === "unknown") && value.reason === undefined;
    }
    if (value.kind !== "settled") return false;
    if (value.reason === "done") return value.actor === "owner" || value.actor === "worker";
    if (value.reason === "untracked" || value.reason === "pair_removed") return value.actor === "operator";
    if (value.reason === "endpoint_retired") return value.actor === "gateway" || value.actor === "operator";
    return (value.reason === "idle_timeout" || value.reason === "tracking_disabled") && value.actor === "gateway";
  }
  const legacyKinds = new Set([
    "opened", "replaced", "activity", "nudge", "worker_reported_complete",
    "capability_degraded", "conversation_rebound", "done", "unresponsive",
    "pair_removed", "endpoint_retired", "disabled",
  ]);
  return exactKeys(value,
    ["sequence", "timestamp", "conversationId", "ownerAlias", "workerAlias", "kind"],
    ["nudgeNumber"]) && legacyKinds.has(value.kind) &&
    (value.kind === "nudge"
      ? value.nudgeNumber === 1 || value.nudgeNumber === 2
      : value.nudgeNumber === undefined);
}

function isV2EndpointRefreshEvent(value: unknown): value is JsonRecord {
  return isRecord(value) && exactKeys(value,
    ["sequence", "timestamp", "alias", "hostId", "threadId", "oldEndpointGeneration", "newEndpointGeneration"],
    ["reason"]) && positiveInteger(value.sequence) && iso(value.timestamp) &&
    typeof value.alias === "string" && ALIAS.test(value.alias) && value.alias.startsWith("codex-") &&
    typeof value.hostId === "string" && HOST.test(value.hostId) && value.alias.endsWith(`@${value.hostId}`) &&
    token(value.threadId) && token(value.oldEndpointGeneration) && token(value.newEndpointGeneration) &&
    (value.reason === undefined
      ? value.oldEndpointGeneration !== value.newEndpointGeneration
      : value.reason === "boot_reactivation");
}

function isV2OrphanEvent(value: unknown): value is JsonRecord {
  return isRecord(value) && exactKeys(value, ["sequence", "timestamp", "alias", "hostId"]) &&
    positiveInteger(value.sequence) && iso(value.timestamp) && typeof value.alias === "string" &&
    ALIAS.test(value.alias) && value.alias.startsWith("codex-") &&
    typeof value.hostId === "string" && HOST.test(value.hostId) &&
    value.alias.endsWith(`@${value.hostId}`);
}

function isV2CodexSuccession(value: unknown): value is JsonRecord {
  if (!isRecord(value) || !exactKeys(value,
    ["schemaVersion", "stage", "old", "new"], ["safeErrorCode"]) ||
    value.schemaVersion !== 1 || typeof value.stage !== "string" ||
    !new Set(["prepared", "publication_armed", "published", "activated", "recovery_forbidden"]).has(value.stage) ||
    !isV2CodexSuccessionIdentity(value.old) || !isV2CodexSuccessionIdentity(value.new)) {
    return false;
  }
  const oldIdentity = value.old;
  const newIdentity = value.new;
  if (
    oldIdentity.hostId !== newIdentity.hostId || oldIdentity.alias === newIdentity.alias ||
    oldIdentity.threadId === newIdentity.threadId || oldIdentity.generation === newIdentity.generation ||
    (oldIdentity.binding as V2Binding).ownerLease === (newIdentity.binding as V2Binding).ownerLease
  ) return false;
  return value.stage === "recovery_forbidden"
    ? safeCode(value.safeErrorCode)
    : value.safeErrorCode === undefined;
}

function isV2CodexSuccessionIdentity(value: unknown): value is JsonRecord {
  return isRecord(value) && exactKeys(value,
    ["alias", "threadId", "hostId", "generation", "binding"]) &&
    typeof value.alias === "string" && ALIAS.test(value.alias) && value.alias.startsWith("codex-") &&
    typeof value.hostId === "string" && HOST.test(value.hostId) &&
    value.alias.endsWith(`@${value.hostId}`) && token(value.threadId) &&
    typeof value.generation === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/.test(value.generation) &&
    isV2Binding(value.binding) && value.binding.provider === "codex" &&
    value.binding.hostId === value.hostId && value.binding.routeHandle === value.threadId;
}

function v2ProgressWatchPairKey(watch: JsonRecord): string {
  return [
    `${String(watch.ownerAlias)}\0${String(watch.ownerLease)}`,
    `${String(watch.workerAlias)}\0${String(watch.workerLease)}`,
  ].sort().join("\0");
}

function sameV2Endpoint(left: V2Binding | JsonRecord, right: V2Binding | JsonRecord): boolean {
  return left.provider === right.provider && left.hostId === right.hostId &&
    left.endpointGeneration === right.endpointGeneration;
}

function sameV2Binding(left: V2Binding, right: V2Binding): boolean {
  return sameV2Endpoint(left, right) && left.routeHandle === right.routeHandle &&
    left.ownerLease === right.ownerLease;
}

function sameV2RouteTarget(left: V2Binding, right: V2Binding): boolean {
  return sameV2Endpoint(left, right) && left.routeHandle === right.routeHandle;
}

function v2RouteMatchesSuccessionIdentity(route: V2Route, identity: JsonRecord): boolean {
  const binding = identity.binding as V2Binding;
  return route.alias === identity.alias && route.registrationMode === "explicit_opt_in" &&
    route.binding.provider === "codex" && route.binding.hostId === identity.hostId &&
    route.binding.routeHandle === identity.threadId && sameV2Binding(route.binding, binding);
}

function isV2SuccessionConsistent(state: V2State): boolean {
  if (state.codexSuccession === null) return true;
  const journal = state.codexSuccession;
  const oldIdentity = journal.old as JsonRecord;
  const newIdentity = journal.new as JsonRecord;
  const newBinding = newIdentity.binding as V2Binding;
  const matchingRoutes = state.routes.filter((route) =>
    v2RouteMatchesSuccessionIdentity(route, oldIdentity) ||
    v2RouteMatchesSuccessionIdentity(route, newIdentity));
  if (matchingRoutes.length !== 1) return false;
  const route = matchingRoutes[0]!;
  const aliases = new Set([String(oldIdentity.alias), String(newIdentity.alias)]);
  if (
    [...state.queue, ...state.inFlight].some((item) =>
      aliases.has(item.sourceAlias) || aliases.has(item.targetAlias)) ||
    route.queueDepth !== 0 ||
    !state.connectors.some((connector) => sameV2Endpoint(connector, newBinding)) ||
    state.routes.some((candidate) => candidate !== route &&
      (candidate.alias === newIdentity.alias ||
        sameV2RouteTarget(candidate.binding, newBinding) ||
        candidate.binding.ownerLease === newBinding.ownerLease))
  ) return false;
  const oldMatches = v2RouteMatchesSuccessionIdentity(route, oldIdentity);
  const newMatches = v2RouteMatchesSuccessionIdentity(route, newIdentity);
  const zeroCounters = Object.values(route.counters).every((value) => value === 0);
  if (journal.stage === "activated") return newMatches && zeroCounters;
  if (journal.stage === "recovery_forbidden") return oldMatches || (newMatches && zeroCounters);
  return oldMatches;
}

function isCounters(value: unknown, accounting = false): boolean {
  const routeKeys = [
    "accepted", "delivered", "unconfirmed", "failed", "ambiguous", "expired",
    "cancelled", "abandoned", "rejected", "bytesAccepted",
  ];
  const keys = accounting
    ? ["accepted", "duplicates", ...routeKeys.slice(1), "queuedBytes"]
    : routeKeys;
  return isRecord(value) && exactKeys(value, keys) &&
    Object.values(value).every(nonNegativeInteger);
}

function compareV2Endpoints(left: V2ConsentEndpoint, right: V2ConsentEndpoint): number {
  const providerOrder = ["claude", "codex", "deepseek", "grok"];
  const providerDifference = providerOrder.indexOf(left.provider) - providerOrder.indexOf(right.provider);
  return providerDifference !== 0 ? providerDifference : left.alias.localeCompare(right.alias);
}

async function validateStateRoot(candidate: string): Promise<string> {
  if (typeof candidate !== "string" || !path.isAbsolute(candidate)) {
    throw conversionError(
      "UNSAFE_GATEWAY_STATE_DIRECTORY",
      "The offline converter requires the configured absolute gateway state directory.",
    );
  }
  const requested = path.resolve(candidate);
  const info = await lstat(requested);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw conversionError(
      "UNSAFE_GATEWAY_STATE_DIRECTORY",
      "The gateway state path must be a real directory.",
    );
  }
  assertOwnedMode(info.uid, info.mode, 0o700, "state directory");
  const root = await realpath(requested);
  if (root !== requested) {
    throw conversionError(
      "UNSAFE_GATEWAY_STATE_DIRECTORY",
      "The gateway state directory changed while it was being attested.",
    );
  }
  const home = await realpath(os.homedir()).catch(() => path.resolve(os.homedir()));
  const temporaryRoot = await realpath(os.tmpdir()).catch(() => path.resolve(os.tmpdir()));
  if (root === path.parse(root).root || root === home || root === temporaryRoot) {
    throw conversionError(
      "UNSAFE_GATEWAY_STATE_DIRECTORY",
      "The gateway state directory must be a dedicated private leaf.",
    );
  }
  return root;
}

async function readPrivateFile(filePath: string, maximumBytes: number): Promise<Buffer> {
  const before = await lstat(filePath);
  if (before.isSymbolicLink() || !before.isFile()) {
    throw conversionError(
      "UNSAFE_GATEWAY_STATE_FILE",
      "A gateway controller file is not a regular file.",
    );
  }
  assertOwnedMode(before.uid, before.mode, 0o600, "state file");
  if (before.size > maximumBytes) {
    throw conversionError(
      "GATEWAY_STATE_FILE_TOO_LARGE",
      "A gateway controller file exceeds its strict byte limit.",
    );
  }
  const handle = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino ||
      opened.size !== before.size || opened.size > maximumBytes
    ) {
      throw conversionError(
        "UNSAFE_GATEWAY_STATE_FILE",
        "A gateway controller file changed during its bounded no-follow read.",
      );
    }
    assertOwnedMode(opened.uid, opened.mode, 0o600, "state file");
    const buffer = Buffer.alloc(maximumBytes + 1);
    let offset = 0;
    while (offset < buffer.byteLength) {
      const result = await handle.read(buffer, offset, buffer.byteLength - offset, offset);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    if (offset > maximumBytes) {
      throw conversionError(
        "GATEWAY_STATE_FILE_TOO_LARGE",
        "A gateway controller file exceeds its strict byte limit.",
      );
    }
    const after = await handle.stat();
    if (
      after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs
    ) {
      throw conversionError(
        "UNSAFE_GATEWAY_STATE_FILE",
        "A gateway controller file changed during its bounded no-follow read.",
      );
    }
    return buffer.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

async function openExclusivePrivate(filePath: string): Promise<FileHandle> {
  return await open(
    filePath,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY |
      (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
}

async function writeExclusivePrivateFile(
  filePath: string,
  body: Buffer,
  kind: "backup",
  fault: (stage: GatewayStateV2ToV3FaultStage) => void | Promise<void>,
): Promise<void> {
  let handle: FileHandle;
  try {
    handle = await openExclusivePrivate(filePath);
  } catch (error) {
    if (nodeCode(error) === "EEXIST") {
      throw conversionError(
        "GATEWAY_STATE_BACKUP_EXISTS",
        "The fixed v2 backup already exists; conversion will not overwrite recovery evidence.",
      );
    }
    throw error;
  }
  try {
    await fault(`before_${kind}_write`);
    await handle.writeFile(body);
    await handle.chmod(0o600);
    await fault(`before_${kind}_file_sync`);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(root: string): Promise<void> {
  const directory = await open(root, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

type OfflineLock = Readonly<{ handle: FileHandle; token: string }>;

async function acquireOfflineLock(root: string, tokenValue: string): Promise<OfflineLock> {
  const lockPath = path.join(root, CONTROLLER_LOCK);
  let handle: FileHandle;
  try {
    handle = await open(
      lockPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_RDWR |
        (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
  } catch (error) {
    if (nodeCode(error) === "EEXIST") {
      throw conversionError(
        "GATEWAY_STATE_IN_USE",
        "The offline converter requires the broker to be stopped and the state lock to be free.",
      );
    }
    throw error;
  }
  try {
    const tokenValueBody = `${JSON.stringify({
      schemaVersion: 1,
      pid: process.pid,
      hostname: os.hostname(),
      token: tokenValue,
    })}\n`;
    await handle.writeFile(tokenValueBody, "utf8");
    await handle.chmod(0o600);
    await handle.sync();
    await syncDirectory(root);
    return { handle, token: tokenValue };
  } catch (error) {
    await handle.close().catch(() => undefined);
    await unlink(lockPath).catch(() => undefined);
    throw error;
  }
}

async function releaseOfflineLock(root: string, lock: OfflineLock): Promise<void> {
  await lock.handle.close().catch(() => undefined);
  const lockPath = path.join(root, CONTROLLER_LOCK);
  try {
    const body = await readPrivateFile(lockPath, MAX_LOCK_BYTES);
    const value = JSON.parse(body.toString("utf8")) as unknown;
    if (isRecord(value) && value.token === lock.token) {
      await unlink(lockPath);
      await syncDirectory(root);
    }
  } catch {
    // Never remove a controller lock whose exact ownership cannot be proven.
  }
}

function assertOwnedMode(uid: number, mode: number, expected: number, kind: string): void {
  if (typeof process.getuid === "function" && uid !== process.getuid()) {
    throw conversionError(
      "UNSAFE_GATEWAY_STATE_DIRECTORY",
      `The gateway ${kind} is not owned by the current process user.`,
    );
  }
  if ((mode & 0o777) !== expected) {
    throw conversionError(
      "UNSAFE_GATEWAY_STATE_DIRECTORY",
      `The gateway ${kind} must have exact mode ${expected.toString(8)}.`,
    );
  }
}

function sha256(body: Buffer): string {
  return createHash("sha256").update(body).digest("hex");
}

function nextRandomId(randomId: () => string): string {
  const value = randomId();
  if (!token(value) || value.length > 128) {
    throw conversionError(
      "GATEWAY_STATE_RANDOM_ID_INVALID",
      "The offline converter could not allocate a bounded private commit identifier.",
    );
  }
  return value;
}

function conversionError(code: string, message: string): BridgeError {
  return new BridgeError(code, message, true);
}

function nodeCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: JsonRecord, required: readonly string[], optional: readonly string[] = []): boolean {
  const keys = Object.keys(value);
  return required.every((key) => Object.hasOwn(value, key)) &&
    keys.every((key) => required.includes(key) || optional.includes(key));
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function iso(value: unknown): value is string {
  return typeof value === "string" && value.length >= 20 && value.length <= 35 &&
    Number.isFinite(Date.parse(value));
}

function provider(value: unknown): value is GatewayProvider {
  return typeof value === "string" && PROVIDERS.has(value);
}

function token(value: unknown): value is string {
  return typeof value === "string" && PRIVATE_TOKEN.test(value);
}

function safeCode(value: unknown): value is string {
  return typeof value === "string" && SAFE_CODE.test(value);
}

function conversationId(value: unknown): value is string {
  return typeof value === "string" && /^conv_[A-Za-z0-9_-]{16,64}$/.test(value);
}

function aliasHost(alias: string): string {
  return alias.slice(alias.lastIndexOf("@") + 1);
}

function direction(value: unknown): value is MessageDirection {
  if (typeof value !== "string") return false;
  const [source, target, extra] = value.split("_to_");
  return extra === undefined && provider(source) && provider(target) && source !== target;
}
