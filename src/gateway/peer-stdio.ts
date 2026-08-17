import { Buffer } from "node:buffer";
import type { Readable, Writable } from "node:stream";
import { decodePeerParams, decodePeerResult, encodePeerFrame, isPeerMethod, PEER_MAX_CATALOG_BYTES, PEER_MAX_REQUEST_BYTES,
  PEER_METHOD_NOT_FOUND, peerInitializeResult, type PeerCatalogResult, type PeerHandoffParams,
  type PeerHandoffResult, type PeerInitializeParams, type PeerRpcError, type PeerRpcId } from "./peer-protocol.js";

type Obj = Record<string, unknown>; type Maybe<T> = T | Promise<T>;
export type PeerStdioHandlers = Readonly<{ initialize: (params: PeerInitializeParams) => Maybe<void>;
  catalog: () => Maybe<PeerCatalogResult>; handoff: (params: PeerHandoffParams) => Maybe<PeerHandoffResult> }>;
export class PeerHandlerError extends Error { constructor(readonly detail: PeerRpcError) { super(detail.message); this.name = "PeerHandlerError"; } }
export type PeerStdioSession = Readonly<{ done: Promise<void>; close: () => void }>;

export function runPeerStdio(options: Readonly<{ localHost: string; handlers: PeerStdioHandlers;
  input?: Readable; output?: Writable }>): PeerStdioSession {
  const input = options.input ?? process.stdin, output = options.output ?? process.stdout; let buffer = Buffer.alloc(0), initialized = false, remoteHost = "", closed = false, operations = Promise.resolve();
  let finish!: () => void; const done = new Promise<void>((resolve) => { finish = resolve; });
  const close = (): void => { if (closed) return; closed = true; input.off("data", read); input.off("end", close); finish(); };
  const write = (id: PeerRpcId | null, result?: unknown, fault?: PeerRpcError, large = false): Promise<void> => {
    if (closed) return Promise.resolve(); let frame: string; try { frame = encodePeerFrame({ jsonrpc: "2.0", id, ...(fault === undefined ? { result } : { error: fault }) }, large ? PEER_MAX_CATALOG_BYTES : PEER_MAX_REQUEST_BYTES); }
    catch { frame = encodePeerFrame({ jsonrpc: "2.0", id, error: { code: -32603, message: "Internal error" } }, PEER_MAX_REQUEST_BYTES); }
    return new Promise((resolve, reject) => { output.write(frame, (error) => error ? reject(error) : resolve()); }); };
  const dispatch = async (message: Obj): Promise<void> => {
    if (closed) return;
    const id = message.id as PeerRpcId, method = message.method;
    if (typeof method !== "string" || !isPeerMethod(method)) return write(id, undefined, { code: PEER_METHOD_NOT_FOUND, message: "Method not found" });
    try { if (method === "initialize") { const params = decodePeerParams(method, message.params);
        if (initialized) throw new PeerHandlerError({ code: -32600, message: "Peer already initialized" });
        await options.handlers.initialize(params); remoteHost = params.host; initialized = true; return write(id, peerInitializeResult(options.localHost)); }
      if (!initialized) throw new PeerHandlerError({ code: -32000, message: "Peer is not initialized" });
      if (method === "catalog/get") { decodePeerParams(method, message.params); return write(id, decodePeerResult(method, await options.handlers.catalog()), undefined, true); }
      const params = decodePeerParams(method, message.params); if (params.source.host !== remoteHost || params.target.host !== options.localHost)
        throw new PeerHandlerError({ code: -32602, message: "Peer handoff must be direct" });
      return write(id, decodePeerResult(method, await options.handlers.handoff(params)));
    } catch (error) { const detail = error instanceof PeerHandlerError ? error.detail :
      { code: error instanceof Error && error.message === "INVALID_PARAMS" ? -32602 : -32603, message: error instanceof Error && error.message === "INVALID_PARAMS" ? "Invalid params" : "Internal error" };
      await write(id, undefined, detail); }
  };
  const read = (chunk: Buffer): void => { if (closed) return; buffer = Buffer.concat([buffer, chunk]);
    for (;;) { const newline = buffer.indexOf(0x0a); if (newline < 0) { if (buffer.length > PEER_MAX_REQUEST_BYTES) close(); return; }
      const line = buffer.subarray(0, newline); buffer = buffer.subarray(newline + 1); if (line.length > PEER_MAX_REQUEST_BYTES) return close();
      let value: unknown; try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line)); } catch { operations = operations.then(() => write(null, undefined, { code: -32700, message: "Parse error" })).catch(close); continue; }
      if (!object(value) || value.jsonrpc !== "2.0" || !id(value.id) || typeof value.method !== "string" || !Object.hasOwn(value, "params") || Object.keys(value).length !== 4)
        { operations = operations.then(() => write(null, undefined, { code: -32600, message: "Invalid Request" })).catch(close); continue; }
      operations = operations.then(() => dispatch(value)).catch(close);
    } };
  input.on("data", read); input.once("end", () => { void operations.then(close); }); input.once("error", close); return { done, close };
}
const object = (value: unknown): value is Obj => typeof value === "object" && value !== null && !Array.isArray(value);
const id = (value: unknown): boolean => typeof value === "string" || typeof value === "number";
