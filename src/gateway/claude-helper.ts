import { randomBytes } from "node:crypto";
import path from "node:path";
import type { Serializable } from "node:child_process";
import { fileURLToPath } from "node:url";
import { BridgeError } from "../errors.js";
import { ClaudePeerAdapter, type ClaudePeerListener, type ClaudePeerPreparedSend } from "./claude-peer.js";
import { composeProvenanceEnvelope } from "./provenance-envelope.js";
import type { GatewayAdapterDispatchResult } from "./service.js";
import {
  assertClaudeNativeHelperIpcSize, CLAUDE_NATIVE_HELPER_MAX_REQUESTS,
  CLAUDE_NATIVE_HELPER_PREPARED_TTL_MS, CLAUDE_NATIVE_HELPER_PROTOCOL_VERSION,
  isClaudeNativeHelperParentMessage, type ClaudeNativeHelperChildMessage,
  type ClaudeNativeHelperCommand, type ClaudeNativeHelperEvent,
  type ClaudeNativeHelperInitialization, type ClaudeNativeHelperResult,
} from "./claude-helper-protocol.js";

type Preparation = { id: string; prepared: ClaudePeerPreparedSend; timer: NodeJS.Timeout };
const safe = (error: unknown): { code: string; recoverable: boolean } => error instanceof BridgeError &&
  /^[A-Z][A-Z0-9_]{0,95}$/.test(error.code) ? { code: error.code, recoverable: error.recoverable } :
  { code: "CLAUDE_NATIVE_HELPER_OPERATION_FAILED", recoverable: false };
const ok = (): Readonly<{ ok: true }> => ({ ok: true });
function send(value: ClaudeNativeHelperChildMessage): Promise<void> {
  assertClaudeNativeHelperIpcSize(value);
  if (!process.send || !process.connected) return Promise.reject(new Error("CLAUDE_NATIVE_HELPER_PARENT_GONE"));
  return new Promise((resolve, reject) => process.send!(value as Serializable, undefined, {},
    (error: Error | null) => error === null ? resolve() : reject(error)));
}

export async function runClaudeNativeHelperProcess(): Promise<void> {
  if (!process.send) return;
  let adapter: ClaudePeerAdapter | undefined, listener: ClaudePeerListener | undefined;
  let registration: ClaudeNativeHelperInitialization["registration"] | undefined;
  let maxPending = 0, preparation: Preparation | undefined, admitted = 0, closing = false;
  const routes = new Map<string, string>();
  let operations = Promise.resolve(), sends = Promise.resolve();
  const queue = (message: ClaudeNativeHelperChildMessage): Promise<void> => {
    const operation = sends.then(() => send(message)); sends = operation.catch(() => undefined); return operation;
  };
  const event = (value: ClaudeNativeHelperEvent): void => { void queue({ protocolVersion: 1, type: "event", value }).catch(shutdown); };
  const respond = (requestId: string, result: ClaudeNativeHelperResult): Promise<void> =>
    queue({ protocolVersion: 1, type: "response", requestId, ok: true, result });
  const reject = (requestId: string, error: unknown): Promise<void> =>
    queue({ protocolVersion: 1, type: "response", requestId, ok: false, error: safe(error) });
  const release = (): void => { const held = preparation; preparation = undefined; if (held) { clearTimeout(held.timer); held.prepared.cancel(); } };
  const take = (id: string): ClaudePeerPreparedSend => {
    const held = preparation;
    if (!held) throw new BridgeError("CLAUDE_NATIVE_PREPARATION_UNKNOWN", "The native preparation is absent or consumed.");
    if (held.id !== id) throw new BridgeError("CLAUDE_NATIVE_PREPARATION_MISMATCH", "The native preparation capability did not match.");
    preparation = undefined; clearTimeout(held.timer);
    return held.prepared;
  };
  const expireReceipt = async (receiptHandle: string | undefined, code: string): Promise<void> => {
    if (!receiptHandle || !listener) return;
    try { await listener.acknowledge(receiptHandle, "expired", { code }); }
    catch { try { listener.releaseInboundReceipt(receiptHandle); } catch { /* detached */ } }
  };
  const inbound = async (message: import("./claude-peer.js").ClaudePeerInboundMessage): Promise<void> => {
    const active = adapter, source = message.sourceTargetId, advertised = registration;
    if (!active || !listener || !advertised || !source || !message.sourceAlias || !message.replySupported) {
      await expireReceipt(message.receiptHandle, "CLAUDE_SOURCE_ROUTE_INVALID"); return;
    }
    let alias: string | undefined;
    try { const discovery = await active.discover(); const found = !discovery.truncated && discovery.peers.find((peer) =>
      peer.targetId === source && peer.kind === "interactive" && peer.alias === message.sourceAlias);
      if (found) alias = `${found.alias}@this-mac`; } catch { /* stale */ }
    if (!alias) { await expireReceipt(message.receiptHandle, "CLAUDE_SOURCE_ROUTE_STALE"); return; }
    if (!routes.has(source) && routes.size >= maxPending) { await expireReceipt(message.receiptHandle, "CLAUDE_NATIVE_INGRESS_CAPACITY"); return; }
    routes.set(source, alias);
    event({ event: "claude_message", value: { routeHandle: source, sourceAlias: alias,
      targetAlias: advertised.alias, text: message.content, ...(message.receiptHandle ? { receiptHandle: message.receiptHandle } : {}) } });
  };
  const initialize = async (message: ClaudeNativeHelperInitialization): Promise<ClaudeNativeHelperResult> => {
    if (adapter || listener || registration) throw new BridgeError("CLAUDE_NATIVE_HELPER_ALREADY_INITIALIZED", "The helper accepts one initialization.");
    const created = new ClaudePeerAdapter({ sessionsDir: message.runtime.sessionsDir, socketDir: message.runtime.socketDir,
      locale: message.locale, deliveryNotices: message.deliveryNotices, maxPendingReceipts: message.maxPendingMessages });
    let opened: ClaudePeerListener | undefined;
    try { opened = await created.listen({ onMessage: inbound,
        onProtocolNotice: (notice) => event({ event: "protocol_notice", value: { code: notice.code } }) });
      const suffix = `@${message.hostId}`;
      if (!message.registration.alias.endsWith(suffix)) throw new BridgeError("INVALID_CODEX_PEER_ALIAS", "The helper alias targets another host.");
      adapter = created; listener = opened; registration = message.registration; maxPending = message.maxPendingMessages;
      await opened.advertise(message.registration.alias.slice(0, -suffix.length), message.registration.cwd);
      return { generation: opened.generation };
    } catch (error) { adapter = undefined; listener = undefined; registration = undefined;
      await opened?.close().catch(() => undefined); await created.close().catch(() => undefined); throw error; }
  };
  const prepare = async (command: Extract<ClaudeNativeHelperCommand, { method: "prepare_dispatch" }>): Promise<ClaudeNativeHelperResult> => {
    if (preparation) throw new BridgeError("CLAUDE_NATIVE_PREPARATION_CAPACITY", "The helper already owns one preparation.", true);
    const active = adapter, opened = listener, advertised = registration;
    if (!active || !opened || !advertised || advertised.alias !== command.sourceAlias || advertised.sourceProvider !== command.sourceProvider)
      throw new BridgeError("CLAUDE_NATIVE_HELPER_NOT_INITIALIZED", "The exact native source advertisement is unavailable.", true);
    const deadlineAt = Date.parse(command.deadlineAt);
    if (!Number.isFinite(deadlineAt) || deadlineAt <= Date.now()) throw new BridgeError("CLAUDE_PEER_MESSAGE_EXPIRED", "The message expired before preparation.", true);
    if (command.authorization === "selected_route") {
      const discovery = await active.discover();
      if (discovery.truncated || !discovery.peers.some((peer) => peer.targetId === command.binding.routeHandle && peer.kind === "interactive"))
        throw new BridgeError("CLAUDE_ROUTE_MISMATCH", "The selected Claude UUID is no longer live.", true);
      await active.assertTargetWorkspaceDisjoint(command.binding.routeHandle, command.stateRoot!);
    } else if (routes.get(command.binding.routeHandle) !== command.targetAlias) {
      throw new BridgeError("CLAUDE_NATIVE_REPLY_STALE", "The native reply route is stale.");
    }
    const content = composeProvenanceEnvelope({ sourceProvider: command.sourceProvider, recipientProvider: "claude",
      sourceAlias: command.sourceAlias, targetAlias: command.targetAlias, conversationId: command.conversationId,
      body: command.text, ...(command.progressWatchActive ? { progressWatchActive: true as const } : {}) });
    const prepared = await active.prepareSend(command.binding.routeHandle, content, { deadlineAt, replyListener: opened });
    const id = `prep_${randomBytes(18).toString("base64url")}`;
    const timer = setTimeout(release, Math.max(1, Math.min(CLAUDE_NATIVE_HELPER_PREPARED_TTL_MS, deadlineAt - Date.now()))); timer.unref();
    preparation = { id, prepared, timer };
    return { preparationId: id, frameBytes: prepared.frameBytes, sha256: prepared.sha256 };
  };
  const execute = async (command: ClaudeNativeHelperCommand): Promise<ClaudeNativeHelperResult> => {
    if (command.method === "prepare_dispatch") return await prepare(command);
    if (command.method === "perform_dispatch") {
      const prepared = take(command.preparationId); const operation = prepared.perform();
      try { await operation; return { state: "delivered" }; }
      catch (error) { return error instanceof BridgeError && error.recoverable
        ? { state: "failed", safeErrorCode: error.code === "CLAUDE_PEER_MESSAGE_EXPIRED" ? "MESSAGE_EXPIRED" : error.code }
        : { state: "ambiguous", safeErrorCode: error instanceof BridgeError ? error.code : "CLAUDE_DISPATCH_OUTCOME_AMBIGUOUS" }; }
    }
    if (command.method === "cancel_dispatch") { take(command.preparationId).cancel(); return ok(); }
    if (!listener || !registration) throw new BridgeError("CLAUDE_NATIVE_HELPER_NOT_INITIALIZED", "The helper is not initialized.");
    if (command.method === "update_status") { if (command.alias === registration.alias) await listener.updateAdvertisedStatus(command.status); return ok(); }
    if (command.method === "unadvertise") { if (command.alias === registration.alias) {
      await listener.unadvertise(command.alias.slice(0, command.alias.lastIndexOf("@"))); registration = undefined; routes.clear(); } return ok(); }
    if (command.method === "update_inbound_status") { await listener.acknowledge(command.receiptHandle, command.status,
      command.diagnosticCode ? { code: command.diagnosticCode } : undefined); return ok(); }
    if (command.method === "notify_inbound_progress") { await listener.notifyInboundProgress(command.receiptHandle, command.progress); return ok(); }
    if (command.method === "release_inbound_receipt") return { released: listener.releaseInboundReceipt(command.receiptHandle) };
    release(); await listener.close(); return ok();
  };
  async function shutdown(): Promise<void> {
    if (closing) return; closing = true; release(); const active = adapter; adapter = undefined; listener = undefined; registration = undefined;
    await active?.close().catch(() => undefined); if (process.connected) process.disconnect(); setImmediate(() => process.exit(0));
  }
  process.on("disconnect", shutdown); process.on("SIGTERM", shutdown); process.on("SIGINT", shutdown);
  process.on("message", (value: unknown) => {
    if (closing) return;
    try { assertClaudeNativeHelperIpcSize(value); if (!isClaudeNativeHelperParentMessage(value)) throw new Error(); }
    catch { void shutdown(); return; }
    if (admitted >= CLAUDE_NATIVE_HELPER_MAX_REQUESTS) { void shutdown(); return; } admitted += 1;
    operations = operations.then(async () => { try { const result = value.type === "initialize" ? await initialize(value) : await execute(value.command);
        await respond(value.requestId, result); if (value.type === "request" && value.command.method === "close") await shutdown(); }
      catch (error) { await reject(value.requestId, error).catch(() => undefined); if (value.type === "initialize") await shutdown(); } })
      .finally(() => { admitted -= 1; });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void runClaudeNativeHelperProcess();
