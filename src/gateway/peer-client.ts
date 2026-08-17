import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { decodePeerParams, decodePeerResult, encodePeerFrame, peerEdgeRef, PEER_MAX_CATALOG_BYTES, PEER_MAX_REQUEST_BYTES,
  PEER_METHOD_NOT_FOUND, PEER_REQUEST_TIMEOUT_MS, type PeerCatalogResult, type PeerHandoffParams, type PeerHandoffResult,
  type PeerMethod, type PeerMethodParams, type PeerMethodResult, type PeerRpcError, type PeerRpcId } from "./peer-protocol.js";

type Obj = Record<string, unknown>;
type Child = Pick<ChildProcessWithoutNullStreams, "kill" | "once" | "stderr" | "stdin" | "stdout">;
export type PeerSpawn = (command: string, args: readonly string[], options: SpawnOptionsWithoutStdio) => Child;
type PeerTimers = Readonly<{ setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout }>;
export type PeerPreparedHandoff = Readonly<{ bodyBytes: number; bodySha256: string; frameBytes: number; sha256: string; cancel: () => void; perform: () => Promise<PeerHandoffResult> }>;
type Pending = Readonly<{ method: PeerMethod; timer: NodeJS.Timeout; resolve: (value: unknown) => void; reject: (error: Error) => void }>;
export class PeerRequestError extends Error { constructor(readonly detail: PeerRpcError) { super(detail.message); this.name = "PeerRequestError"; } }
export class PeerConnectionLostError extends Error { constructor(message = "Peer connection lost") { super(message); this.name = "PeerConnectionLostError"; } }

export class PeerClient {
  private pending = new Map<PeerRpcId, Pending>(); private nextId = 1; private buffer = Buffer.alloc(0);
  private writes: Promise<void> = Promise.resolve(); private closed = false; private remoteHost = "";
  private constructor(private child: Child, private localHost: string, private timers: PeerTimers) { child.stderr.resume(); child.stdout.on("data", (chunk: Buffer) => this.read(chunk));
    child.once("error", () => this.fail(new PeerConnectionLostError())); child.once("exit", () => this.fail(new PeerConnectionLostError())); }
  static async spawn(options: Readonly<{ node: string; localHost: string; spawn?: PeerSpawn; timers?: PeerTimers }>): Promise<PeerClient> {
    decodePeerParams("initialize", { protocolVersion: 1, host: options.node }); decodePeerParams("initialize", { protocolVersion: 1, host: options.localHost });
    let child: Child; try { child = (options.spawn ?? nodeSpawn)("/usr/bin/ssh",
      ["-T", "-x", "-o", "BatchMode=yes", "-o", "ClearAllForwardings=yes", "-o", "ForwardAgent=no", "-o", "PermitLocalCommand=no", "-o", "SendEnv=-*", "-o", "Tunnel=no", options.node, "embassy", "peer-stdio"],
      { env: peerEnvironment(process.env), shell: false, stdio: ["pipe", "pipe", "pipe"] }); } catch { throw new PeerConnectionLostError(); }
    const client = new PeerClient(child, options.localHost, options.timers ?? { setTimeout, clearTimeout }); try { const result = await client.request("initialize", { protocolVersion: 1, host: options.localHost });
      if (result.host !== options.node) throw new Error(`Peer host mismatch: expected ${options.node}, received ${result.host}`);
      client.remoteHost = result.host; return client; } catch (error) { client.close(); throw error; }
  }
  get connectionInfo(): Readonly<{ host: string; protocolVersion: 1 }> { return { host: this.remoteHost, protocolVersion: 1 }; }
  async catalog(): Promise<PeerCatalogResult> { const result = await this.request("catalog/get", {});
    const routeIds = result.routes.flatMap((row) => [row.alias, row.ref]), connectorIds = result.connectors.map((row) => row.provider);
    const invalid = (result.complete && result.truncated) || new Set(routeIds).size !== routeIds.length || new Set(connectorIds).size !== connectorIds.length ||
      [...result.routes, ...result.connectors].some((row) => row.host !== this.remoteHost) || result.consentEdges.some((edge) => {
        const hosts = edge.endpoints.map((endpoint) => endpoint.host).sort();
        return hosts[0] !== [this.localHost, this.remoteHost].sort()[0] || hosts[1] !== [this.localHost, this.remoteHost].sort()[1] ||
          edge.ownerHost !== hosts[0] || edge.ref !== peerEdgeRef(edge.endpoints);
      }) || new Set(result.consentEdges.map((edge) => edge.ref)).size !== result.consentEdges.length ||
      result.alerts.some((alert) => (alert.host !== undefined && alert.host !== this.remoteHost) ||
        (alert.alias !== undefined && !alert.alias.endsWith(`@${this.remoteHost}`))) || result.consentEdges.some((edge) => edge.endpoints
          .filter((endpoint) => endpoint.host === this.remoteHost).some((endpoint) => !result.routes.some((route) =>
            route.alias === endpoint.alias && route.provider === endpoint.provider && route.ref === endpoint.routeRef)));
    if (invalid) { const error = new Error("Peer catalog is not a local, canonical projection"); this.fail(error); throw error; } return result; }
  prepareHandoff(params: PeerHandoffParams): PeerPreparedHandoff {
    decodePeerParams("handoff", params); if (this.closed) throw new PeerConnectionLostError();
    if (params.source.host !== this.localHost || params.target.host !== this.remoteHost) throw new Error("Peer handoff must be direct");
    const id = this.nextId++, frame = encodePeerFrame({ jsonrpc: "2.0", id, method: "handoff", params }, PEER_MAX_REQUEST_BYTES);
    let state: "prepared" | "performed" | "cancelled" = "prepared"; const used = (): never => { throw new Error("Peer handoff was already consumed"); };
    return { bodyBytes: Buffer.byteLength(params.body), bodySha256: createHash("sha256").update(params.body).digest("hex"), frameBytes: Buffer.byteLength(frame), sha256: createHash("sha256").update(frame).digest("hex"),
      cancel: () => { if (state !== "prepared") used(); state = "cancelled"; }, perform: () => { if (state !== "prepared") return Promise.reject(used());
        state = "performed"; return this.requestFrame("handoff", id, frame); } };
  }
  close(): void { this.fail(new PeerConnectionLostError()); }
  private request<M extends PeerMethod>(method: M, params: PeerMethodParams[M]): Promise<PeerMethodResult[M]> { const id = this.nextId++;
    return this.requestFrame(method, id, encodePeerFrame({ jsonrpc: "2.0", id, method, params }, PEER_MAX_REQUEST_BYTES)); }
  private requestFrame<M extends PeerMethod>(method: M, id: PeerRpcId, frame: string): Promise<PeerMethodResult[M]> {
    if (this.closed) return Promise.reject(new PeerConnectionLostError()); return new Promise<unknown>((resolve, reject) => { const timer = this.timers.setTimeout(() => {
      this.timers.clearTimeout(timer); this.pending.delete(id); const error = new PeerConnectionLostError("Peer request timed out"); this.fail(error); reject(error); }, PEER_REQUEST_TIMEOUT_MS); timer.unref();
      this.pending.set(id, { method, timer, resolve, reject });
      void this.write(frame).catch((error) => { const pending = this.pending.get(id); if (pending) this.timers.clearTimeout(pending.timer); this.pending.delete(id); this.fail(error); reject(error); }); }) as Promise<PeerMethodResult[M]>;
  }
  private write(frame: string): Promise<void> { const operation = this.writes.then(() => new Promise<void>((resolve, reject) => {
    if (this.closed) return reject(new PeerConnectionLostError()); this.child.stdin.write(frame, (error) => error ? reject(new PeerConnectionLostError()) : resolve()); }));
    this.writes = operation.catch(() => undefined); return operation; }
  private read(chunk: Buffer): void { if (this.closed) return; this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) { const newline = this.buffer.indexOf(0x0a); if (newline < 0) { if (this.buffer.length > PEER_MAX_CATALOG_BYTES) this.fail(new Error("Peer response exceeds 256 KiB")); return; }
      const line = this.buffer.subarray(0, newline); this.buffer = this.buffer.subarray(newline + 1); if (line.length > PEER_MAX_CATALOG_BYTES) return this.fail(new Error("Peer response exceeds 256 KiB"));
      let message: unknown; try { message = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line)); } catch { return this.fail(new Error("Peer returned malformed JSON")); }
      if (!object(message) || message.jsonrpc !== "2.0") return this.fail(new Error("Peer returned an invalid JSON-RPC frame"));
      if (typeof message.method === "string") { if (!request(message)) return this.fail(new Error("Peer returned an invalid request"));
        void this.write(encodePeerFrame({ jsonrpc: "2.0", id: message.id, error: { code: PEER_METHOD_NOT_FOUND, message: "Method not found" } }, PEER_MAX_REQUEST_BYTES)).catch((error) => this.fail(error)); continue; }
      if (!response(message)) return this.fail(new Error("Peer returned an invalid JSON-RPC response")); const pending = this.pending.get(message.id as PeerRpcId);
      if (!pending) return this.fail(new Error("Peer returned an uncorrelated response")); this.pending.delete(message.id as PeerRpcId); this.timers.clearTimeout(pending.timer);
      if (Object.hasOwn(message, "error")) { const detail = error(message.error); if (detail === undefined) { const fault = new Error("Peer returned an invalid error response"); pending.reject(fault); this.fail(fault); } else pending.reject(new PeerRequestError(detail)); } else try { pending.resolve(decodePeerResult(pending.method, message.result)); }
      catch (fault) { const error = fault instanceof Error ? fault : new Error("Invalid peer result"); pending.reject(error); this.fail(error); }
    } }
  private fail(error: Error): void { if (this.closed) return; this.closed = true; for (const pending of this.pending.values()) { this.timers.clearTimeout(pending.timer); pending.reject(error); } this.pending.clear(); this.child.kill(); }
}
const peerEnvironment = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => Object.fromEntries(
  ["HOME", "USER", "LOGNAME", "SSH_AUTH_SOCK"].flatMap((key) => env[key] === undefined ? [] : [[key, env[key]!]]));
const object = (value: unknown): value is Obj => typeof value === "object" && value !== null && !Array.isArray(value);
const id = (value: unknown): boolean => typeof value === "string" || typeof value === "number";
const request = (value: Obj): boolean => Object.keys(value).length === 4 && id(value.id) && typeof value.method === "string" && Object.hasOwn(value, "params");
const response = (value: Obj): boolean => Object.keys(value).length === 3 && id(value.id) && (Object.hasOwn(value, "result") !== Object.hasOwn(value, "error"));
function error(value: unknown): PeerRpcError | undefined { if (!object(value) || typeof value.code !== "number" || typeof value.message !== "string" ||
  Object.keys(value).some((key) => key !== "code" && key !== "message" && key !== "data")) return undefined;
  return { code: value.code, message: value.message, ...(Object.hasOwn(value, "data") ? { data: value.data } : {}) }; }
export const spawnPeerClient = (options: Parameters<typeof PeerClient.spawn>[0]): Promise<PeerClient> => PeerClient.spawn(options);
