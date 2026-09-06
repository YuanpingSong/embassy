import { randomUUID } from "node:crypto";

import { BridgeError } from "../errors.js";
import type { ClaudePeerAdapter, ClaudePeerDescriptor } from "./claude-peer.js";
import type { CodexThread } from "./codex-discovery.js";
import { Ledger, nativeKey, sameEndpoint, type Endpoint, type EndpointRef, type LedgerLimits, type LedgerState } from "./ledger.js";
import type { OwnedStateFile } from "./owned-state.js";

const ALIAS = /^[a-z][a-z0-9_-]{0,31}@[a-z0-9](?:[a-z0-9.-]{0,61}[a-z0-9])?$/;
const HOST = /^[a-z0-9](?:[a-z0-9.-]{0,61}[a-z0-9])?$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REGISTRATION = /^reg_[A-Za-z0-9_-]{1,252}$/;

export type ClaudeDirectoryAdapter = Pick<ClaudePeerAdapter,
  "discover" | "resolveReplyAddress" | "assertTargetWorkspaceDisjoint">;
export type RemoteEndpointResolver = Readonly<{
  named: (alias: string) => Promise<readonly Endpoint[]>;
  exact: (identity: EndpointRef) => Promise<Endpoint | undefined>;
}>;
export type EndpointCaller = Readonly<{ kind: "codex"; handle: string }> |
  Readonly<{ kind: "claude"; address: string }>;
export type CodexEndpointMetadata = Readonly<{
  state: CodexThread["status"];
  canAcceptDirectInput: boolean | "unknown";
  parentEndpoint?: string;
}>;
export type CodexReconciliation = Readonly<{ endpoints: readonly Endpoint[]; truncated: boolean }>;
export type EndpointDirectoryOptions = Readonly<{
  host: string; limits: LedgerLimits; store: OwnedStateFile<LedgerState>;
  claude: ClaudeDirectoryAdapter; remote?: RemoteEndpointResolver;
  createRegistrationId?: (provider: "claude" | "codex", handle: string) => string;
}>;

const allowedClaude = (peer: ClaudePeerDescriptor): boolean =>
  peer.kind === "interactive" || peer.kind === "bg";
const reference = ({ id, host, provider }: Endpoint): EndpointRef => ({ id, host, provider });

export class EndpointDirectory {
  readonly #createRegistrationId: (provider: "claude" | "codex", handle: string) => string;
  readonly #collidingAliases = new Set<string>();
  readonly #observedClaudeAliases = new Set<string>();
  #codexMetadata = new Map<string, CodexThread>();
  #codexProofIncomplete = false;
  #completeRefreshObserved = false;
  #proofOverflow = false;

  constructor(readonly options: EndpointDirectoryOptions) {
    if (!HOST.test(options.host)) throw new BridgeError("INVALID_GATEWAY_CONFIGURATION", "The endpoint host is invalid.");
    this.#createRegistrationId = options.createRegistrationId ?? (() => `reg_${randomUUID()}`);
  }

  async registerCodex(handle: string, alias: string, succeeds?: string): Promise<Endpoint> {
    this.#assertAlias(alias, true);
    if (succeeds !== undefined) this.#assertAlias(succeeds, true);
    if (!UUID.test(handle)) {
      throw new BridgeError("INVALID_GATEWAY_CONFIGURATION", "The Codex registration is invalid.");
    }
    return await this.options.store.transact((state, now) => {
      const ledger = new Ledger(state, this.options.host, this.options.limits, now.getTime());
      const normalizedHandle = handle.toLowerCase();
      const existing = state.endpoints.find((row) => row.provider === "codex" && row.handle === normalizedHandle);
      if (succeeds !== undefined) {
        const predecessor = ledger.resolve(succeeds);
        if (predecessor === undefined || predecessor.provider !== "codex") {
          throw new BridgeError("ROUTE_UNREGISTERED", "The predecessor route is absent.");
        }
        if (predecessor.handle !== normalizedHandle) ledger.retire(reference(predecessor));
      }
      const endpoint: Endpoint = {
        id: existing?.id ?? this.#id("codex", normalizedHandle), host: this.options.host, provider: "codex",
        alias, handle: normalizedHandle,
      };
      if (state.endpoints.some((row) => row.alias === alias && !sameEndpoint(row, endpoint))) {
        throw new BridgeError("PEER_ALIAS_COLLISION", "The requested Codex alias is already in use.");
      }
      ledger.register(endpoint);
      return endpoint;
    });
  }

  async reconcileCodex(threads: readonly CodexThread[], positiveRemovedIds: readonly string[] = [],
    incomplete = false): Promise<CodexReconciliation> {
    const current = new Map<string, CodexThread>();
    for (const thread of threads) {
      if (!UUID.test(thread.id)) throw new BridgeError("INVALID_GATEWAY_CONFIGURATION", "The discovered Codex identity is invalid.");
      current.set(thread.id.toLowerCase(), { ...thread, id: thread.id.toLowerCase() });
    }
    const removed = new Set(positiveRemovedIds.map((id) => {
      if (!UUID.test(id)) throw new BridgeError("INVALID_GATEWAY_CONFIGURATION", "The removed Codex identity is invalid.");
      return id.toLowerCase();
    }));
    const reconciled = await this.options.store.transact((state, now) => {
      const ledger = new Ledger(state, this.options.host, this.options.limits, now.getTime());
      for (const handle of removed) {
        const endpoint = state.endpoints.find((row) => row.provider === "codex" && row.handle === handle);
        if (endpoint !== undefined) ledger.retire(reference(endpoint));
      }
      let overflow = false;
      const metadata: [string, CodexThread][] = [];
      for (const [handle, thread] of current) {
        const existing = state.endpoints.find((row) => row.provider === "codex" && row.handle === handle);
        if (state.retirements.some((row) => row.nativeKey === nativeKey({ provider: "codex", handle }))) continue;
        if (existing === undefined && state.endpoints.length >= this.options.limits.endpoints) {
          overflow = true;
          continue;
        }
        const endpoint: Endpoint = { id: existing?.id ?? this.#id("codex", handle), host: this.options.host,
          provider: "codex", alias: "", handle };
        endpoint.alias = this.#codexAlias(thread, endpoint.id);
        ledger.register(endpoint);
        metadata.push([endpoint.id, thread]);
      }
      return { endpoints: state.endpoints.filter((row) => row.provider === "codex"), metadata, overflow };
    });
    const retainedIds = new Set(reconciled.endpoints.map((endpoint) => endpoint.id));
    for (const id of this.#codexMetadata.keys()) if (!retainedIds.has(id)) this.#codexMetadata.delete(id);
    if (!incomplete && !reconciled.overflow) this.#codexMetadata.clear();
    for (const [id, thread] of reconciled.metadata) this.#codexMetadata.set(id, thread);
    this.#codexProofIncomplete = incomplete || reconciled.overflow;
    return { endpoints: reconciled.endpoints, truncated: this.#codexProofIncomplete };
  }

  codexMetadata(endpoint: Endpoint, allEndpoints: readonly Endpoint[]): CodexEndpointMetadata | undefined {
    if (endpoint.provider !== "codex") return undefined;
    const thread = this.#codexMetadata.get(endpoint.id);
    if (thread === undefined) return { state: "unknown", canAcceptDirectInput: "unknown" };
    const parent = thread.parentThreadId === undefined ? undefined : allEndpoints.find((row) =>
      row.provider === "codex" && row.handle === thread.parentThreadId!.toLowerCase());
    return { state: thread.status, canAcceptDirectInput: thread.canAcceptDirectInput ?? "unknown",
      ...(parent === undefined ? {} : { parentEndpoint: parent.id }) };
  }

  async caller(input: EndpointCaller): Promise<Endpoint> {
    if (input.kind === "codex") {
      if (!UUID.test(input.handle)) throw new BridgeError("ROUTE_UNREGISTERED", "The Codex caller is invalid.");
      const matches = (await this.options.store.snapshot()).endpoints.filter((row) =>
        row.provider === "codex" && row.handle === input.handle.toLowerCase());
      if (matches.length !== 1) throw new BridgeError("ROUTE_UNREGISTERED", "The Codex caller is not registered.");
      return matches[0]!;
    }
    const peer = await this.options.claude.resolveReplyAddress(input.address);
    if (!allowedClaude(peer)) throw new BridgeError("CLAUDE_REPLY_ROUTE_MISMATCH", "The caller is not an interactive Claude session.");
    return await this.#recordClaude(peer);
  }

  async named(selector: string): Promise<Endpoint | undefined> {
    if (UUID.test(selector)) {
      const peer = (await this.options.claude.discover()).peers.find((row) =>
        row.targetId.toLowerCase() === selector.toLowerCase() && allowedClaude(row));
      if (peer === undefined) return undefined;
      const endpoint = await this.#recordClaude(peer);
      await this.options.claude.assertTargetWorkspaceDisjoint(peer.targetId, this.options.store.rootDir);
      return endpoint;
    }
    if (!ALIAS.test(selector)) return undefined;
    const at = selector.lastIndexOf("@");
    if (selector.slice(at + 1) !== this.options.host) return await this.#remoteNamed(selector);
    const before = await this.options.store.snapshot();
    const known = before.endpoints.filter((row) => row.alias === selector);
    const codex = known.filter((row) => row.provider === "codex");
    if (codex.length > 1 || this.#codexProofIncomplete && selector.startsWith("codex-")) {
      throw new BridgeError("PEER_ALIAS_COLLISION", "A complete Codex discovery is required to resolve this name.");
    }
    let live: Endpoint[];
    try {
      live = await this.refresh();
    } catch (error) {
      if (this.#proofOverflow || this.#collidingAliases.has(selector) || !this.#completeRefreshObserved && known.length > 1) {
        throw new BridgeError("PEER_ALIAS_COLLISION", "The endpoint name is ambiguous.");
      }
      if (codex.length === 1 && (known.length === 1 ||
        this.#completeRefreshObserved && !this.#observedClaudeAliases.has(selector))) return codex[0];
      throw error;
    }
    if (this.#proofOverflow || this.#collidingAliases.has(selector)) {
      throw new BridgeError("PEER_ALIAS_COLLISION", "A complete discovery is required to clear this name's collision.");
    }
    const matches = live.filter((row) => row.alias === selector);
    if (matches.length > 1) throw new BridgeError("PEER_ALIAS_COLLISION", "The endpoint name is ambiguous.");
    const endpoint = matches[0];
    if (endpoint === undefined && before.retirements.some((row) => row.alias === selector)) {
      throw new BridgeError("ROUTE_UNREGISTERED", "The endpoint name belongs to a retired identity.");
    }
    if (endpoint?.provider === "claude") {
      await this.options.claude.assertTargetWorkspaceDisjoint(endpoint.handle, this.options.store.rootDir);
    }
    return endpoint;
  }

  async exact(identity: EndpointRef): Promise<Endpoint | undefined> {
    if (identity.host !== this.options.host) {
      const endpoint = await this.options.remote?.exact(identity);
      if (endpoint === undefined) return undefined;
      if (!this.#validRemote(endpoint) || !sameEndpoint(endpoint, identity)) {
        throw new BridgeError("INVALID_PEER_CATALOG", "The remote endpoint identity is invalid.");
      }
      return endpoint;
    }
    const endpoint = (await this.options.store.snapshot()).endpoints.find((row) => sameEndpoint(row, identity));
    if (endpoint === undefined || endpoint.provider === "codex") return endpoint;
    const peer = (await this.options.claude.discover()).peers.find((row) =>
      row.targetId.toLowerCase() === endpoint.handle && allowedClaude(row));
    if (peer === undefined) return undefined;
    const current = await this.#recordClaude(peer);
    if (!sameEndpoint(current, identity)) return undefined;
    await this.options.claude.assertTargetWorkspaceDisjoint(peer.targetId, this.options.store.rootDir);
    return current;
  }

  async refresh(): Promise<Endpoint[]> {
    const discovery = await this.options.claude.discover();
    const peers = discovery.peers.filter(allowedClaude);
    const refreshed = await this.options.store.transact((state, now) => {
      const ledger = new Ledger(state, this.options.host, this.options.limits, now.getTime());
      const current = peers.flatMap((peer) => {
        const endpoint = this.#upsertClaude(ledger, state, peer, true);
        return endpoint === undefined ? [] : [endpoint];
      });
      if (!discovery.truncated) return { listed: current, observed: current };
      const seen = new Set(current.map((row) => row.id));
      return { observed: current, listed: [...current,
        ...state.endpoints.filter((row) => row.provider === "claude" && !seen.has(row.id))] };
    });
    const observed = refreshed.observed.map((row) => row.alias);
    const codex = (await this.options.store.snapshot()).endpoints.filter((row) => row.provider === "codex");
    const collisions = new Set(observed.filter((alias, index) =>
      observed.indexOf(alias) !== index || codex.some((row) => row.alias === alias)));
    if (!discovery.truncated) {
      this.#completeRefreshObserved = true;
      this.#observedClaudeAliases.clear();
      this.#collidingAliases.clear();
      this.#proofOverflow = false;
    }
    for (const [set, aliases] of [[this.#observedClaudeAliases, observed], [this.#collidingAliases, collisions]] as const) {
      for (const alias of aliases) {
        if (set.has(alias)) continue;
        if (set.size < this.options.limits.endpoints) set.add(alias);
        else this.#proofOverflow = true;
      }
    }
    return [...codex, ...refreshed.listed];
  }

  #upsertClaude(ledger: Ledger, state: LedgerState, peer: ClaudePeerDescriptor, skipRetired = false): Endpoint | undefined {
    if (!UUID.test(peer.targetId) || !allowedClaude(peer)) {
      throw new BridgeError("CLAUDE_ROUTE_MISMATCH", "The discovered Claude identity is invalid.");
    }
    const alias = `${peer.alias}@${this.options.host}`;
    this.#assertAlias(alias, false);
    const handle = peer.targetId.toLowerCase();
    const existing = state.endpoints.find((row) => row.provider === "claude" && row.handle === handle);
    const endpoint: Endpoint = { id: existing?.id ?? this.#id("claude", handle), host: this.options.host,
      provider: "claude", alias, handle };
    if (state.retirements.some((row) => sameEndpoint(row.endpoint, endpoint) || row.nativeKey === nativeKey(endpoint))) {
      if (skipRetired) return undefined;
      throw new BridgeError("ROUTE_UNREGISTERED", "The Claude endpoint was retired.");
    }
    ledger.register(endpoint);
    return endpoint;
  }

  async #recordClaude(peer: ClaudePeerDescriptor): Promise<Endpoint> {
    return await this.options.store.transact((state, now) => {
      const endpoint = this.#upsertClaude(
        new Ledger(state, this.options.host, this.options.limits, now.getTime()), state, peer,
      );
      if (endpoint === undefined) throw new RangeError("CLAUDE_ENDPOINT_MISSING");
      return endpoint;
    });
  }

  async #remoteNamed(alias: string): Promise<Endpoint | undefined> {
    const matches = await this.options.remote?.named(alias) ?? [];
    if (matches.some((row) => !this.#validRemote(row) || row.alias !== alias)) {
      throw new BridgeError("INVALID_PEER_CATALOG", "The remote endpoint projection is invalid.");
    }
    if (matches.length > 1) throw new BridgeError("PEER_ALIAS_COLLISION", "The endpoint name is ambiguous.");
    return matches[0];
  }

  #validRemote(endpoint: Endpoint): boolean {
    return endpoint.host !== this.options.host && HOST.test(endpoint.host) && REGISTRATION.test(endpoint.id) &&
      (endpoint.provider === "claude" || endpoint.provider === "codex") && ALIAS.test(endpoint.alias) &&
      endpoint.alias.endsWith(`@${endpoint.host}`) && endpoint.handle.length > 0 && endpoint.handle.length <= 256 &&
      !endpoint.handle.includes("\0");
  }

  #assertAlias(alias: string, codex: boolean): void {
    if (!ALIAS.test(alias) || !alias.endsWith(`@${this.options.host}`) || codex && !alias.startsWith("codex-")) {
      throw new BridgeError("INVALID_GATEWAY_CONFIGURATION", "The endpoint alias is invalid.");
    }
  }

  #codexAlias(thread: CodexThread, id: string): string {
    const candidate = thread.name?.trim() || thread.agentNickname?.trim() || "";
    const native = thread.id.toLowerCase().replace(/[^a-z0-9]/gu, "");
    const exposesNative = candidate.toLowerCase().replace(/[^a-z0-9]/gu, "").includes(native);
    let local = candidate.normalize("NFKD").toLowerCase().replace(/\p{M}/gu, "")
      .replace(/[^a-z0-9_-]+/gu, "-").replace(/^[-_]+|[-_]+$/gu, "").replace(/[-_]{2,}/gu, "-");
    if (!local || exposesNative) {
      const publicPart = id.slice(4).toLowerCase().replace(/[^a-z0-9]/gu, "").slice(0, 18) || "endpoint";
      local = `agent-${publicPart}`;
    }
    if (!local.startsWith("codex-")) local = `codex-${local}`;
    const alias = `${local.slice(0, 32)}@${this.options.host}`;
    this.#assertAlias(alias, true);
    return alias;
  }

  #id(provider: "claude" | "codex", handle: string): string {
    const id = this.#createRegistrationId(provider, handle);
    if (!REGISTRATION.test(id)) throw new RangeError("INVALID_REGISTRATION_ID");
    return id;
  }
}
