import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { connectorHealthStates, gatewayProviders, routeStates,
  type ConnectorHealth, type GatewayProvider, type RouteState } from "./types.js";

export const PEER_PROTOCOL_VERSION = 2, PEER_MAX_REQUEST_BYTES = 32 * 1024,
  PEER_MAX_CATALOG_BYTES = 256 * 1024, PEER_MAX_BODY_BYTES = 16 * 1024,
  PEER_REQUEST_TIMEOUT_MS = 30_000, PEER_METHOD_NOT_FOUND = -32601;
export const peerCapabilities = ["catalog", "handoff"] as const;
export type PeerRpcId = string | number;
export type PeerRpcError = Readonly<{ code: number; message: string; data?: unknown }>;
export type PeerMethod = "initialize" | "catalog/get" | "handoff";
export type PeerEndpoint = Readonly<{ alias: string; provider: GatewayProvider; host: string; routeRef: string }>;
export type PeerInitializeParams = Readonly<{ protocolVersion: typeof PEER_PROTOCOL_VERSION; host: string }>;
export type PeerInitializeResult = Readonly<{ protocolVersion: typeof PEER_PROTOCOL_VERSION; host: string; capabilities: typeof peerCapabilities;
  limits: Readonly<{ requestBytes: number; catalogBytes: number; bodyBytes: number }> }>;
/**
 * A federated handoff is authorized by the sending host's membership in the
 * destination's nodes.json plus exact alias addressing; the wire carries no
 * permission record beyond the two endpoints.
 */
export type PeerHandoffParams = Readonly<{ originAttemptId: string; originMessageId: string;
  source: PeerEndpoint; target: PeerEndpoint; deadlineAt: string;
  expectsReply: boolean; body: string; steer?: true; conversationCorrelation?: string }>;
export type PeerHandoffResult = Readonly<{ accepted: true }>;
export type PeerCatalogResult = Readonly<{ revision: number; complete: boolean; truncated: boolean;
  generatedAt: string; health: ConnectorHealth;
  connectors: readonly Readonly<{ provider: GatewayProvider; host: string; health: ConnectorHealth;
    protocol: string; protocolVersion: string; lastSeenAt?: string; observationAgeMs?: number; safeErrorCode?: string }>[];
  routes: readonly Readonly<{ ref: string; alias: string; provider: GatewayProvider; host: string;
    enabled: boolean; state: RouteState; queueDepth: number; lastSeenAt?: string; safeErrorCode?: string }>[];
  alerts: readonly Readonly<{ code: string; severity: "info" | "warning" | "error"; timestamp: string;
    provider?: GatewayProvider; host?: string; alias?: string }>[] }>;
export type PeerMethodParams = { initialize: PeerInitializeParams; "catalog/get": Readonly<Record<string, never>>; handoff: PeerHandoffParams };
export type PeerMethodResult = { initialize: PeerInitializeResult; "catalog/get": PeerCatalogResult; handoff: PeerHandoffResult };

type Obj = Record<string, unknown>; type Check = (value: unknown) => boolean;
const providers = new Set<string>(gatewayProviders), health = new Set<string>(connectorHealthStates), states = new Set<string>(routeStates);
const host: Check = (v) => typeof v === "string" && /^[a-z0-9](?:[a-z0-9.-]{0,61}[a-z0-9])?$/.test(v);
const code: Check = (v) => typeof v === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(v);
const alias: Check = (v) => typeof v === "string" && /^[a-z][a-z0-9_-]{0,31}@[a-z0-9](?:[a-z0-9.-]{0,61}[a-z0-9])?$/.test(v);
const atom: Check = (v) => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9_.+-]{0,63}$/.test(v);
const date: Check = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v) && new Date(v).toISOString() === v;
const natural: Check = (v) => Number.isSafeInteger(v) && (v as number) >= 0;
const bool: Check = (v) => typeof v === "boolean";
const member = (set: ReadonlySet<string>): Check => (v) => typeof v === "string" && set.has(v);
const optional = (check: Check): Check => (v) => v === undefined || check(v);
const token = (prefix: string): Check => (v) => typeof v === "string" && v.startsWith(prefix) && v.length > prefix.length && v.length <= 160 && /^[A-Za-z0-9_-]+$/.test(v);
const list = (check: Check, max: number): Check => (v) => Array.isArray(v) && v.length <= max && v.every(check);
const exact = (v: unknown, fields: Record<string, Check>): v is Obj => object(v) &&
  Object.keys(v).every((key) => Object.hasOwn(fields, key)) && Object.entries(fields).every(([key, check]) => check(v[key]));
const object = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const coordinate = (v: Obj): boolean => (v.alias as string).endsWith(`@${String(v.host)}`);
const endpoint: Check = (v) => exact(v, { alias, provider: member(providers), host, routeRef: token("reg_") }) &&
  ((v as Obj).alias as string).endsWith(`@${String((v as Obj).host)}`);

export class PeerProtocolError extends Error { constructor(readonly code: string) { super(code); this.name = "PeerProtocolError"; } }
export const isPeerMethod = (value: unknown): value is PeerMethod => value === "initialize" || value === "catalog/get" || value === "handoff";
export function peerRouteRef(hostId: string, registrationId: string): string {
  if (!host(hostId) || typeof registrationId !== "string" || registrationId.length === 0)
    throw new PeerProtocolError("INVALID_ROUTE_AUTHORITY");
  return `reg_${createHash("sha256").update(`${hostId}\0${registrationId}`).digest("base64url")}`;
}
export function peerInitializeResult(localHost: string): PeerInitializeResult { return { protocolVersion: PEER_PROTOCOL_VERSION, host: localHost,
  capabilities: peerCapabilities, limits: { requestBytes: PEER_MAX_REQUEST_BYTES, catalogBytes: PEER_MAX_CATALOG_BYTES, bodyBytes: PEER_MAX_BODY_BYTES } }; }
export function decodePeerParams<M extends PeerMethod>(method: M, value: unknown): PeerMethodParams[M] {
  const valid = method === "initialize" ? exact(value, { protocolVersion: (v) => v === PEER_PROTOCOL_VERSION, host }) : method === "catalog/get" ? exact(value, {}) :
    exact(value, { originAttemptId: token("attempt_"), originMessageId: token("msg_"), source: endpoint, target: endpoint,
      deadlineAt: date, expectsReply: bool,
      body: (v) => typeof v === "string" && Buffer.byteLength(v, "utf8") > 0 && Buffer.byteLength(v, "utf8") <= PEER_MAX_BODY_BYTES,
      steer: optional((v) => v === true), conversationCorrelation: optional((v) => typeof v === "string" && /^[A-Za-z0-9_-]{8}$/.test(v)) });
  if (!valid) throw new PeerProtocolError("INVALID_PARAMS"); return value as PeerMethodParams[M];
}
export function decodePeerResult<M extends PeerMethod>(method: M, value: unknown): PeerMethodResult[M] {
  const valid = method === "initialize" ? exact(value, { protocolVersion: (v) => v === PEER_PROTOCOL_VERSION, host,
    capabilities: (v) => Array.isArray(v) && v.length === 2 && v[0] === "catalog" && v[1] === "handoff",
    limits: (v) => exact(v, { requestBytes: (x) => x === PEER_MAX_REQUEST_BYTES, catalogBytes: (x) => x === PEER_MAX_CATALOG_BYTES, bodyBytes: (x) => x === PEER_MAX_BODY_BYTES }) }) :
    method === "handoff" ? exact(value, { accepted: (v) => v === true }) : exact(value, { revision: natural, complete: bool, truncated: bool, generatedAt: date, health: member(health),
      connectors: list((v) => exact(v, { provider: member(providers), host, health: member(health), protocol: atom, protocolVersion: atom, lastSeenAt: optional(date), observationAgeMs: optional(natural), safeErrorCode: optional(code) }), 64),
      routes: list((v) => exact(v, { ref: token("reg_"), alias, provider: member(providers), host, enabled: bool, state: member(states), queueDepth: natural, lastSeenAt: optional(date), safeErrorCode: optional(code) }) && coordinate(v as Obj), 256),
      alerts: list((v) => exact(v, { code, severity: member(new Set(["info", "warning", "error"])), timestamp: date, provider: optional(member(providers)), host: optional(host), alias: optional(alias) }), 256) });
  if (!valid) throw new PeerProtocolError("INVALID_RESULT"); return value as PeerMethodResult[M];
}
export function encodePeerFrame(value: unknown, maximum: number): string { const frame = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(frame, "utf8") > maximum) throw new PeerProtocolError("FRAME_TOO_LARGE"); return frame; }
