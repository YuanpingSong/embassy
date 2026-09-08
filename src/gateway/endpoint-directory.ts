import { randomUUID } from "node:crypto";

import { BridgeError } from "../errors.js";
import { normalizeClaudeAlias, type ClaudePeerAdapter, type ClaudePeerDescriptor } from "./claude-peer.js";
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
}>;
export type CodexReconciliation = Readonly<{ endpoints: readonly Endpoint[]; truncated: boolean }>;
export type ClaudeSessionWarning = Readonly<{
  code: "CLAUDE_SESSION_DUPLICATE"; alias: string; selectedPid: number; newestPid: number;
  otherPids: readonly number[]; reason: "stale_older" | "unreachable_newest" | "all_unreachable";
}>;
export type EndpointDirectoryOptions = Readonly<{
  host: string; limits: LedgerLimits; store: OwnedStateFile<LedgerState>;
  automaticCodex?: boolean;
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
  readonly #claudeWarnings = new Map<string, ClaudeSessionWarning>();
  #codexMetadata = new Map<string, CodexThread>();
  #automaticCodex: boolean;
  #codexProofIncomplete = false;
  #completeRefreshObserved = false;
  #proofOverflow = false;

  constructor(readonly options: EndpointDirectoryOptions) {
    this.#automaticCodex = options.automaticCodex ?? false;
    if (!HOST.test(options.host)) throw new BridgeError("INVALID_GATEWAY_CONFIGURATION", "The endpoint host is invalid.");
    this.#createRegistrationId = options.createRegistrationId ?? (() => `reg_${randomUUID()}`);
  }

  claudeWarnings(endpoints?: readonly Endpoint[]): readonly ClaudeSessionWarning[] {
    return [...this.#claudeWarnings.entries()]
      .filter(([handle]) => !endpoints || endpoints.some((row) => row.host === this.options.host && row.provider === "claude" && row.handle === handle))
      .map(([, warning]) => warning);
  }

  #observeClaude(peer: ClaudePeerDescriptor): void {
    if (!allowedClaude(peer) || !peer.duplicate) return; // Only a complete scan can clear prior evidence.
    const handle = peer.targetId.toLowerCase();
    this.#claudeWarnings.delete(handle);
    this.#claudeWarnings.set(handle, {
      code: "CLAUDE_SESSION_DUPLICATE", alias: `${normalizeClaudeAlias(peer.alias)}@${this.options.host}`, ...peer.duplicate,
    });
    // Match the public endpoint bound and the registry's maximum PID budget,
    // including warnings retained across partial scans or caller observations.
    while (this.#claudeWarnings.size > 128 || [...this.#claudeWarnings.values()].reduce((sum, row) => sum + 1 + row.otherPids.length, 0) > 4096)
      this.#claudeWarnings.delete(this.#claudeWarnings.keys().next().value!);
  }

  async #discoverClaude() {
    const discovery = await this.options.claude.discover();
    if (!discovery.truncated) this.#claudeWarnings.clear();
    for (const peer of discovery.peers) this.#observeClaude(peer);
    return discovery;
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
        alias, handle: normalizedHandle, retained: true,
      };
      if (state.endpoints.some((row) => row.alias === alias && !sameEndpoint(row, endpoint))) {
        throw new BridgeError("PEER_ALIAS_COLLISION", "The requested Codex alias is already in use.");
      }
      ledger.register(endpoint);
      return endpoint;
    });
  }

  async reconcileCodex(threads: readonly CodexThread[], positiveRemovedIds: readonly string[] = [],
    incomplete = false, confirmedWindow = !incomplete): Promise<CodexReconciliation> {
    this.#automaticCodex = true;
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
      if (confirmedWindow && !incomplete) state.endpoints = state.endpoints.filter((row) =>
        row.provider !== "codex" || row.retained || current.has(row.handle) ||
        state.deliveries.some((delivery) => delivery.state.phase !== "terminal" &&
          (sameEndpoint(delivery.source, row) || sameEndpoint(delivery.target, row))));
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
          provider: "codex", alias: "", handle, ...(existing?.retained ? { retained: true as const } : {}) };
        endpoint.alias = existing?.retained ? existing.alias : this.#codexAlias(thread, endpoint.id);
        ledger.register(endpoint);
        metadata.push([endpoint.id, thread]);
      }
      return { endpoints: state.endpoints.filter((row) => row.provider === "codex"), metadata, overflow };
    });
    const retainedIds = new Set(reconciled.endpoints.map((endpoint) => endpoint.id));
    for (const id of this.#codexMetadata.keys()) if (!retainedIds.has(id)) this.#codexMetadata.delete(id);
    if (confirmedWindow && !incomplete && !reconciled.overflow) this.#codexMetadata.clear();
    for (const [id, thread] of reconciled.metadata) this.#codexMetadata.set(id, thread);
    this.#codexProofIncomplete = incomplete || reconciled.overflow || (!confirmedWindow && this.#codexProofIncomplete);
    return { endpoints: reconciled.endpoints, truncated: this.#codexProofIncomplete };
  }

  codexMetadata(endpoint: Endpoint): CodexEndpointMetadata | undefined {
    if (endpoint.provider !== "codex") return undefined;
    const thread = this.#codexMetadata.get(endpoint.id);
    return { state: thread?.status ?? "unknown" };
  }

  listed(endpoints: readonly Endpoint[]): Endpoint[] {
    if (!this.#automaticCodex) return [...endpoints];
    const order = new Map([...this.#codexMetadata.keys()].map((id, index) => [id, index]));
    return [...endpoints.filter((row) => row.provider === "codex" && (row.retained || order.has(row.id)))
      .sort((a, b) => (order.get(a.id) ?? 20) - (order.get(b.id) ?? 20)),
      ...endpoints.filter((row) => row.provider !== "codex")];
  }

  async caller(input: EndpointCaller): Promise<Endpoint> {
    if (input.kind === "codex") {
      if (!UUID.test(input.handle)) throw new BridgeError("ROUTE_UNREGISTERED", "The Codex caller is invalid.");
      const matches = this.listed((await this.options.store.snapshot()).endpoints).filter((row) =>
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
      const peer = (await this.#discoverClaude()).peers.find((row) =>
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
    const known = this.listed(before.endpoints).filter((row) => row.alias === selector);
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
    const peer = (await this.#discoverClaude()).peers.find((row) =>
      row.targetId.toLowerCase() === endpoint.handle && allowedClaude(row));
    if (peer === undefined) return undefined;
    const current = await this.#recordClaude(peer);
    if (!sameEndpoint(current, identity)) return undefined;
    await this.options.claude.assertTargetWorkspaceDisjoint(peer.targetId, this.options.store.rootDir);
    return current;
  }

  async refresh(): Promise<Endpoint[]> {
    const discovery = await this.#discoverClaude();
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
    const codex = this.listed((await this.options.store.snapshot()).endpoints).filter((row) => row.provider === "codex");
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
    const alias = `${normalizeClaudeAlias(peer.alias)}@${this.options.host}`;
    this.#assertAlias(alias, false);
    const handle = peer.targetId.toLowerCase();
    const existing = state.endpoints.find((row) => row.provider === "claude" && row.handle === handle);
    const endpoint: Endpoint = { id: existing?.id ?? this.#id("claude", handle), host: this.options.host,
      provider: "claude", alias, handle };
    if (state.retirements.some((row) => sameEndpoint(row.endpoint, endpoint))) {
      if (skipRetired) return undefined;
      throw new BridgeError("ROUTE_UNREGISTERED", "The Claude endpoint was retired.");
    }
    ledger.register(endpoint);
    return endpoint;
  }

  async #recordClaude(peer: ClaudePeerDescriptor): Promise<Endpoint> {
    this.#observeClaude(peer);
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
    const candidate = thread.name?.trim().toLowerCase() === "untitled task" ? "" : thread.name?.trim() ?? "";
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
