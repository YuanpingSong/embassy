import { BridgeError } from "../errors.js";
import type { MessagingBroker } from "./broker.js";
import type { EndpointCaller } from "./endpoint-directory.js";
import type { EndpointRef } from "./ledger.js";
import type { FederatedHandoff, PublicEndpoint } from "./federation.js";

export type BrokerCommand =
  | { method: "health" | "list_snapshot" | "refresh_discovery" | "check"; params: Record<string, never> }
  | { method: "register_codex"; params: { caller: EndpointCaller; alias: string; succeeds?: string } }
  | { method: "send"; params: { caller: EndpointCaller; body: string; to?: string; conversation?: string } }
  | { method: "retire_route"; params: { alias: string } }
  | { method: "delivery_status"; params: { token: string } }
  | { method: "peer_catalog"; params: { node: string } }
  | { method: "peer_resolve"; params: { node: string; selector: string | EndpointRef } }
  | { method: "peer_handoff"; params: { node: string; handoff: FederatedHandoff } };
type Obj = Record<string, unknown>;
const object = (x: unknown): x is Obj => !!x && typeof x === "object" && !Array.isArray(x);
const exact = (x: unknown, keys: readonly string[], optional: readonly string[] = []): x is Obj => object(x) &&
  keys.every((key) => Object.hasOwn(x, key)) && Object.keys(x).every((key) => keys.includes(key) || optional.includes(key));
const alias = (x: unknown): x is string => typeof x === "string" && /^[a-z][a-z0-9_-]{0,31}@[a-z0-9](?:[a-z0-9.-]{0,61}[a-z0-9])?$/.test(x);
const host = (x: unknown): x is string => typeof x === "string" && /^[a-z0-9](?:[a-z0-9.-]{0,61}[a-z0-9])?$/.test(x);
const uuid = (x: unknown): x is string => typeof x === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(x);
const token = (x: unknown, prefix: string, length: string) => typeof x === "string" && new RegExp(`^${prefix}[A-Za-z0-9_-]{${length}}$`).test(x);
const ref = (x: unknown) => exact(x, ["id", "host", "provider"]) && token(x.id, "reg_", "1,252") && host(x.host) && (x.provider === "claude" || x.provider === "codex");
const caller = (x: unknown): x is EndpointCaller => exact(x, ["kind", "handle"]) && x.kind === "codex" && uuid(x.handle) ||
  exact(x, ["kind", "address"]) && x.kind === "claude" && typeof x.address === "string" &&
  x.address.startsWith("uds:/") && x.address.length <= 256 && !x.address.includes("\0");
const invalid = (): never => { throw new BridgeError("INVALID_REQUEST", "The control request is invalid."); };
const count = (x: unknown) => Number.isSafeInteger(x) && (x as number) >= 0;
const code = (x: unknown) => typeof x === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(x);
const date = (x: unknown) => typeof x === "string" && Number.isFinite(Date.parse(x)) && new Date(x).toISOString() === x;
const outcomes = ["delivered", "failed", "cancelled", "expired", "ambiguous", "unconfirmed"];
const endpoint = (x: unknown): boolean => exact(x, ["id", "host", "provider", "alias"]) &&
  ref({ id: x.id, host: x.host, provider: x.provider }) && alias(x.alias) && x.alias.endsWith(`@${x.host}`);
const rows = (x: unknown, maximum: number, accepts: (row: unknown) => boolean): boolean =>
  Array.isArray(x) && x.length <= maximum && x.every(accepts);
const endpoints = (x: unknown, accepts = endpoint): boolean => rows(x, 128, accepts) &&
  new Set((x as Obj[]).map((row) => JSON.stringify([row.host, row.id]))).size === (x as Obj[]).length;

/** One public projection contract, used before emission and after transport. Native
 * handles and arbitrary adapter fields can never hitchhike in a valid result. */
export function isBrokerResult(method: BrokerCommand["method"], value: unknown): boolean {
  switch (method) {
    case "health": return exact(value, ["status"]) && ["healthy", "degraded"].includes(String(value.status));
    case "check": return exact(value, ["status", "scope"]) && value.status === "ok" && value.scope === "broker-loopback";
    case "register_codex": return endpoint(value);
    case "send": return exact(value, ["accepted", "conversationId", "deliveryToken"]) && value.accepted === true &&
      token(value.conversationId, "conv_", "16,64") && token(value.deliveryToken, "dlv_", "24");
    case "retire_route": return exact(value, ["cancelled", "ambiguous", "unconfirmed"]) && Object.values(value).every(count);
    case "refresh_discovery": return exact(value, ["routes"]) && endpoints(value.routes);
    case "peer_catalog": return endpoints(value);
    case "peer_resolve": return value === null || endpoint(value);
    case "peer_handoff": return exact(value, ["accepted"]) && value.accepted === true ||
      exact(value, ["accepted", "code"]) && value.accepted === false && code(value.code);
    case "delivery_status": return exact(value, ["found"]) && value.found === false ||
      exact(value, ["found", "state", "terminal", "deadlineAt"], ["pendingForMs", "safeErrorCode"]) && value.found === true && date(value.deadlineAt) &&
      (value.terminal === true ? outcomes.includes(String(value.state)) && code(value.safeErrorCode) && value.pendingForMs === undefined
        : value.terminal === false && value.state === "queued" && count(value.pendingForMs) && value.safeErrorCode === undefined);
    case "list_snapshot": return exact(value, ["health", "revision", "routes", "messages", "retirements"], ["safeErrorCode", "federation"]) &&
      ["healthy", "degraded"].includes(String(value.health)) && count(value.revision) &&
      (value.safeErrorCode === undefined || code(value.safeErrorCode)) &&
      (value.federation === undefined || exact(value.federation, ["nodes", "truncated"]) && typeof value.federation.truncated === "boolean" &&
        rows(value.federation.nodes, 32, (node) => exact(node, ["host", "routes"], ["observedAt", "safeErrorCode"]) && host(node.host) &&
          endpoints(node.routes, (row) => endpoint(row) && (row as Obj).host === node.host) &&
          (node.observedAt === undefined || date(node.observedAt)) &&
          (node.safeErrorCode === undefined || node.safeErrorCode === "PEER_TUNNEL_UNAVAILABLE")) &&
        new Set((value.federation.nodes as Obj[]).map((node) => node.host)).size === (value.federation.nodes as Obj[]).length &&
        (value.federation.nodes as Obj[]).reduce((sum, node) => sum + (node.routes as unknown[]).length, 0) <= 128) &&
      endpoints(value.routes, (row) => exact(row, ["id", "alias", "provider", "host", "queueDepth"], ["lastOperation"]) &&
        endpoint({ id: row.id, alias: row.alias, provider: row.provider, host: row.host }) && count(row.queueDepth) &&
        (row.lastOperation === undefined || exact(row.lastOperation, ["outcome", "code"]) &&
          [...outcomes, "deferred"].includes(String(row.lastOperation.outcome)) && code(row.lastOperation.code))) &&
      rows(value.messages, 600, (row) => exact(row, ["state", "ageMs"], ["source", "target", "safeErrorCode"]) &&
        [...outcomes, "queued", "reserved", "armed", "accepted"].includes(String(row.state)) && count(row.ageMs) &&
        (row.source === undefined || alias(row.source)) && (row.target === undefined || alias(row.target)) &&
        (row.safeErrorCode === undefined || code(row.safeErrorCode))) &&
      rows(value.retirements, 500, (row) => exact(row, ["alias", "at"]) && alias(row.alias) && date(row.at));
  }
}

/** Closed application vocabulary; the Unix envelope/version belongs to local-control. */
export function parseBrokerCommand(input: unknown, validateHandoff: (x: unknown) => boolean): BrokerCommand {
  if (!exact(input, ["method", "params"]) || typeof input.method !== "string") return invalid();
  const p = input.params;
  let valid = false;
  switch (input.method) {
    case "health": case "list_snapshot": case "refresh_discovery": case "check": valid = exact(p, []); break;
    case "register_codex": valid = exact(p, ["caller", "alias"], ["succeeds"]) && caller(p.caller) && p.caller.kind === "codex" && alias(p.alias) &&
      (p.succeeds === undefined || alias(p.succeeds)); break;
    case "send": valid = exact(p, ["caller", "body"], ["to", "conversation"]) && caller(p.caller) && typeof p.body === "string" &&
      p.body.trim().length > 0 && !p.body.includes("\0") && Buffer.byteLength(p.body) <= 16_384 &&
      (Object.hasOwn(p, "to") !== Object.hasOwn(p, "conversation")) &&
      (p.to === undefined ? token(p.conversation, "conv_", "16,64") : alias(p.to) || uuid(p.to)); break;
    case "retire_route": valid = exact(p, ["alias"]) && alias(p.alias); break;
    case "delivery_status": valid = exact(p, ["token"]) && token(p.token, "dlv_", "24"); break;
    case "peer_catalog": valid = exact(p, ["node"]) && host(p.node); break;
    case "peer_resolve": valid = exact(p, ["node", "selector"]) && host(p.node) && (alias(p.selector) || ref(p.selector)); break;
    case "peer_handoff": valid = exact(p, ["node", "handoff"]) && host(p.node) && validateHandoff(p.handoff); break;
  }
  return valid ? input as BrokerCommand : invalid();
}

export type BrokerControlOptions = Readonly<{
  broker: MessagingBroker; validateHandoff: (x: unknown) => boolean;
  check: () => Promise<unknown>;
}>;
const publicEndpoint = ({ id, host, provider, alias }: PublicEndpoint): PublicEndpoint => ({ id, host, provider, alias });

export async function handleBrokerCommand(input: unknown, options: BrokerControlOptions) {
  try {
    const command = parseBrokerCommand(input, options.validateHandoff);
    const broker = options.broker;
    let result: unknown;
    switch (command.method) {
      case "health": result = { status: (await broker.status()).health }; break;
      case "list_snapshot": result = await broker.status(); break;
      case "refresh_discovery": result = await broker.refresh(); break;
      case "register_codex": result = await broker.register(command.params.caller, command.params.alias, command.params.succeeds); break;
      case "send": result = await broker.send(command.params.caller,
        command.params.to === undefined ? { conversation: command.params.conversation! } : { to: command.params.to }, command.params.body); break;
      case "retire_route": result = await broker.retire(command.params.alias); break;
      case "delivery_status": result = await broker.delivery(command.params.token); break;
      case "check": result = await options.check(); break;
      case "peer_catalog": case "peer_resolve": case "peer_handoff": {
        if (!broker.options.nodes?.includes(command.params.node)) throw new BridgeError("PEER_NOT_CONFIGURED", "The node is not configured.");
        if (command.method === "peer_catalog") result = (await broker.options.directory.refresh()).map(publicEndpoint);
        else if (command.method === "peer_handoff") result = await broker.handoff(command.params.node, command.params.handoff);
        else {
          const selected = command.params.selector;
          if (typeof selected === "string" ? !selected.endsWith(`@${broker.options.host}`) : selected.host !== broker.options.host) return invalid();
          const endpoint = typeof selected === "string" ? await broker.options.directory.named(selected) : await broker.options.directory.exact(selected);
          result = endpoint ? publicEndpoint(endpoint) : null;
        }
        break;
      }
    }
    if (!isBrokerResult(command.method, result)) throw new BridgeError("INVALID_HANDLER_RESPONSE", "The result is outside the public projection.");
    return { ok: true as const, result };
  } catch (error) {
    return { ok: false as const, code: error instanceof BridgeError && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code) ? error.code : "HANDLER_FAILURE" };
  }
}

export const commandMutates = (method: BrokerCommand["method"]): boolean =>
  !["health", "list_snapshot", "delivery_status", "peer_catalog", "peer_resolve"].includes(method);
