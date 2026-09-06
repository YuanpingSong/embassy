import { BridgeError } from "../errors.js";
import { emptyLedger, sameEndpoint, type Delivery, type EndpointRef, type LedgerLimits, type LedgerState } from "./ledger.js";
import type { OwnedStateCodec } from "./owned-state.js";

const ALIAS = /^[a-z][a-z0-9_-]{0,31}@[a-z0-9](?:[a-z0-9.-]{0,61}[a-z0-9])?$/;
const HOST = /^[a-z0-9](?:[a-z0-9.-]{0,61}[a-z0-9])?$/;
const REGISTRATION = /^reg_[A-Za-z0-9_-]{1,252}$/;
const MESSAGE = /^msg_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONVERSATION = /^conv_[A-Za-z0-9_-]{16,64}$/;
const DELIVERY = /^dlv_[A-Za-z0-9_-]{24}$/;
const ATTEMPT = /^attempt_[A-Za-z0-9_-]{1,252}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const SAFE_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const PROVIDERS = new Set(["claude", "codex"]);
const OUTCOMES = new Set(["delivered", "failed", "cancelled", "expired", "ambiguous", "unconfirmed"]);

type Obj = Record<string, unknown>;
type Check = (value: unknown) => boolean;
const object = (value: unknown): value is Obj => typeof value === "object" && value !== null && !Array.isArray(value);
const exact = (value: unknown, keys: readonly string[], optional: readonly string[] = []): value is Obj => object(value) &&
  keys.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => keys.includes(key) || optional.includes(key));
const natural = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const bounded = (value: unknown, maximum: number): value is string => typeof value === "string" &&
  value.length > 0 && value.length <= maximum && !value.includes("\0");
const boundedText = (value: unknown, maximum: number): value is string => typeof value === "string" &&
  value.length > 0 && !value.includes("\0") && Buffer.byteLength(value, "utf8") <= maximum;
const list = (value: unknown, check: Check): boolean => Array.isArray(value) && value.every(check);

function endpointRef(value: unknown): value is EndpointRef {
  return exact(value, ["id", "host", "provider"]) && typeof value.id === "string" &&
    REGISTRATION.test(value.id) && typeof value.host === "string" && HOST.test(value.host) &&
    typeof value.provider === "string" && PROVIDERS.has(value.provider);
}

function endpoint(value: unknown, host: string): boolean {
  return exact(value, ["id", "host", "provider", "alias", "handle"]) &&
    typeof value.id === "string" && REGISTRATION.test(value.id) && value.host === host &&
    typeof value.provider === "string" && PROVIDERS.has(value.provider) &&
    typeof value.alias === "string" && ALIAS.test(value.alias) && value.alias.endsWith(`@${host}`) &&
    bounded(value.handle, 256);
}

function prepared(value: unknown, limits: LedgerLimits): boolean {
  return exact(value, ["bytes", "sha256", "bodies"]) && natural(value.bytes) && value.bytes > 0 &&
    value.bytes <= limits.wakeBytes && typeof value.sha256 === "string" && SHA256.test(value.sha256) &&
    Array.isArray(value.bodies) && value.bodies.length > 0 && value.bodies.length <= limits.perEndpoint &&
    value.bodies.every((hash) => typeof hash === "string" && SHA256.test(hash));
}

function phase(value: unknown, limits: LedgerLimits): boolean {
  if (!object(value) || typeof value.phase !== "string") return false;
  const tries = (candidate: unknown): boolean => natural(candidate) &&
    Number(candidate) <= 1 + Math.ceil(limits.deadlineMs / 500);
  if (value.phase === "queued") return exact(value, ["phase", "tries", "readyAt"]) && tries(value.tries) && natural(value.readyAt);
  if (value.phase === "reserved") return exact(value, ["phase", "attempt", "tries"]) &&
    typeof value.attempt === "string" && ATTEMPT.test(value.attempt) && tries(value.tries);
  if (value.phase === "armed") return exact(value, ["phase", "attempt", "tries", "prepared"]) &&
    typeof value.attempt === "string" && ATTEMPT.test(value.attempt) && tries(value.tries) && prepared(value.prepared, limits);
  if (value.phase === "accepted") return exact(value, ["phase", "attempt", "tries", "prepared", "loss"]) &&
    typeof value.attempt === "string" && ATTEMPT.test(value.attempt) && tries(value.tries) && prepared(value.prepared, limits) &&
    (value.loss === "ambiguous" || value.loss === "unconfirmed");
  return value.phase === "terminal" && exact(value, ["phase", "outcome", "at", "code"]) &&
    typeof value.outcome === "string" && OUTCOMES.has(value.outcome) && natural(value.at) &&
    typeof value.code === "string" && SAFE_CODE.test(value.code);
}

function delivery(value: unknown, limits: LedgerLimits): value is Delivery {
  if (!exact(value, ["id", "reply", "token", "source", "target", "body", "admittedAt", "deadline",
    "steer", "state"], ["sourceAlias"]) || typeof value.id !== "string" || !MESSAGE.test(value.id) ||
    typeof value.reply !== "string" || !CONVERSATION.test(value.reply) || typeof value.token !== "string" ||
    !DELIVERY.test(value.token) || !endpointRef(value.source) || !endpointRef(value.target) ||
    !boundedText(value.body, limits.bodyBytes) || !natural(value.admittedAt) || !natural(value.deadline) ||
    value.deadline <= value.admittedAt || value.deadline > value.admittedAt + limits.deadlineMs ||
    typeof value.steer !== "boolean" || (value.sourceAlias !== undefined &&
      (typeof value.sourceAlias !== "string" || !ALIAS.test(value.sourceAlias) || !value.sourceAlias.endsWith(`@${value.source.host}`))) ||
    !phase(value.state, limits)) return false;
  const parsed = value as unknown as Delivery;
  if (parsed.state.phase === "terminal" && parsed.state.at < parsed.admittedAt) return false;
  return !parsed.steer || parsed.source.provider === "claude" && parsed.target.provider === "codex" && parsed.body.startsWith("STEER:");
}

const duplicate = <T>(values: readonly T[], key: (value: T) => string): boolean =>
  new Set(values.map(key)).size !== values.length;
const corrupt = (): never => { throw new BridgeError("CORRUPT_GATEWAY_STATE", "The ledger exceeds its configured bounds."); };

export function createLedgerCodec(host: string, limits: LedgerLimits): OwnedStateCodec<LedgerState> {
  if (!HOST.test(host) || Object.values(limits).some((value) => !Number.isSafeInteger(value) || value < 1)) {
    throw new BridgeError("INVALID_GATEWAY_CONFIGURATION", "The ledger codec configuration is invalid.");
  }
  const decode = (value: unknown): LedgerState | undefined => {
    if (!exact(value, ["schemaVersion", "commit", "endpoints", "deliveries", "retirements", "rates"]) ||
      value.schemaVersion !== 6 || !exact(value.commit, ["sequence", "id"]) || !natural(value.commit.sequence) ||
      !bounded(value.commit.id, 128) || !list(value.endpoints, (row) => endpoint(row, host)) ||
      !list(value.deliveries, (row) => delivery(row, limits)) ||
      !list(value.retirements, (row) => exact(row, ["endpoint", "nativeKey", "alias", "at"]) && endpointRef(row.endpoint) &&
        typeof row.nativeKey === "string" && /^[a-f0-9]{64}$/.test(row.nativeKey) &&
        row.endpoint.host === host && typeof row.alias === "string" && ALIAS.test(row.alias) &&
        row.alias.endsWith(`@${host}`) && natural(row.at)) ||
      !list(value.rates, (row) => exact(row, ["source", "since", "count"]) && endpointRef(row.source) &&
        natural(row.since) && natural(row.count) && row.count > 0 && row.count <= limits.rate)) return undefined;
    const state = value as LedgerState;
    if (state.deliveries.some((d) => (d.source.host === host) === (d.sourceAlias !== undefined) ||
      (d.source.host !== host && d.target.host !== host))) return undefined;
    if (duplicate(state.endpoints, (row) => row.id) ||
      duplicate(state.endpoints, (row) => `${row.provider}\0${row.handle}`) ||
      duplicate(state.deliveries, (row) => row.id) || duplicate(state.deliveries, (row) => row.reply) ||
      duplicate(state.deliveries, (row) => row.token) || duplicate(state.retirements, (row) => row.endpoint.id) ||
      duplicate(state.rates, (row) => `${row.source.host}\0${row.source.provider}\0${row.source.id}`)) return undefined;
    const exactLocal = (ref: EndpointRef): boolean => ref.host !== host ||
      state.endpoints.some((endpoint) => sameEndpoint(endpoint, ref));
    if (state.deliveries.some((row) => row.state.phase !== "terminal" &&
      (!exactLocal(row.source) || !exactLocal(row.target))) || state.retirements.some((row) =>
        state.endpoints.some((endpoint) => sameEndpoint(endpoint, row.endpoint)))) return undefined;
    const attempts = new Map<string, string>();
    for (const row of state.deliveries) {
      if (row.state.phase === "queued" || row.state.phase === "terminal") continue;
      const signature = JSON.stringify([{ id: row.target.id, host: row.target.host, provider: row.target.provider },
        row.steer, row.state.phase,
        "prepared" in row.state ? row.state.prepared : null]);
      const prior = attempts.get(row.state.attempt);
      if (prior !== undefined && prior !== signature) return undefined;
      attempts.set(row.state.attempt, signature);
    }
    return state;
  };
  return {
    schemaVersion: 6,
    maximumBytes: 8 * 1024 * 1024,
    decode,
    create: ({ commit }) => ({ ...emptyLedger(), commit }),
    assertBounds: (state) => {
      const pending = state.deliveries.filter((row) => row.state.phase !== "terminal");
      const terminal = state.deliveries.length - pending.length;
      const inFlight = new Set<string>();
      const perTarget = new Map<string, number>();
      for (const row of pending) {
        if (row.state.phase !== "queued" && row.state.phase !== "terminal") inFlight.add(row.state.attempt);
        const key = `${row.target.host}\0${row.target.provider}\0${row.target.id}`;
        perTarget.set(key, (perTarget.get(key) ?? 0) + 1);
      }
      if (state.endpoints.length > limits.endpoints || pending.length > limits.queued || terminal > limits.retained ||
        state.retirements.length > limits.retained || state.rates.length > limits.retained ||
        inFlight.size > limits.inFlight || [...perTarget.values()].some((count) => count > limits.perEndpoint) ||
        pending.reduce((sum, row) => sum + Buffer.byteLength(row.body), 0) > limits.queueBytes ||
        state.deliveries.filter((row) => row.state.phase === "terminal")
          .reduce((sum, row) => sum + Buffer.byteLength(row.body), 0) > limits.retainedBytes) corrupt();
    },
  };
}
