import { PassThrough, type Readable, type Writable } from "node:stream";
import { emitKeypressEvents } from "node:readline";
import type { BrokerCommand } from "./broker-control.js";

type Input = Pick<Readable, "on" | "off"> & {
  isTTY?: boolean;
  isRaw?: boolean;
  readableFlowing?: boolean | null;
  pause?: Readable["pause"];
  resume?: Readable["resume"];
  setRawMode?: (enabled: boolean) => unknown;
};
type Output = Pick<Writable, "write"> & {
  isTTY?: boolean;
  columns?: number;
  rows?: number;
  on?: Writable["on"];
  off?: Writable["off"];
};
export type TuiDependencies = Readonly<{
  input: Input;
  output: Output;
  call: (command: BrokerCommand) => Promise<unknown>;
  renderStatus: (snapshot: unknown) => string;
  host?: string;
  hint?: (code: string, host?: string) => string;
  remote?: Readonly<{ hosts: readonly string[]; call: (host: string, command: BrokerCommand) => Promise<unknown>; close: () => void }>;
  signal?: AbortSignal;
}>;
type Obj = Record<string, unknown>;
type Section = "endpoints" | "deliveries" | "retirements" | "result";
type Mode = "browse" | "token" | "confirm";
type EndpointRow = Readonly<{
  id: string;
  alias: string;
  provider: string;
  host: string;
  local: boolean;
  queueDepth?: number;
  lastOperation?: Obj;
  observedAt?: string;
  safeErrorCode?: string;
  codex?: Obj;
  placeholder?: boolean;
}>;
type DeliverySummary = Readonly<{ summary: true; rows: readonly Obj[] }>;
export type TuiModel = {
  snapshot?: Obj;
  snapshotAt?: number;
  staleSince?: number;
  error?: string;
  errorDetail?: string;
  action?: string;
  actionRunning?: boolean;
  host?: string;
  restarted?: boolean;
  section: Section;
  previousSection?: Exclude<Section, "result">;
  selected: Record<Exclude<Section, "result">, number> & Partial<Record<"result", number>>;
  selectedEndpoint?: string;
  mode: Mode;
  token: string;
  retiring?: EndpointRow;
  result?: Readonly<{ label: string; value: string }>;
};

const object = (value: unknown): value is Obj => !!value && typeof value === "object" && !Array.isArray(value);
const list = (value: unknown): Obj[] => Array.isArray(value) ? value.filter(object) : [];
const text = (value: unknown, fallback = "not reported"): string =>
  typeof value === "string" && value.length > 0 ? value : fallback;
const clean = (value: unknown): string => text(value, "").replace(/[\u0000-\u001f\u007f-\u009f]/g, (character) =>
  character === "\n" || character === "\r" || character === "\t" ? " " : "?");
const errorText = (error: unknown): string => {
  if (object(error) && typeof error.code === "string") return clean(error.code);
  if (error instanceof Error && typeof (error as Error & { code?: unknown }).code === "string")
    return clean((error as Error & { code: string }).code);
  return "CONTROL_UNAVAILABLE";
};
const age = (milliseconds: unknown): string => {
  const ms = typeof milliseconds === "number" && Number.isFinite(milliseconds) ? Math.max(0, milliseconds) : 0;
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${Math.floor(ms / 1_000)}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
  return `${Math.floor(ms / 3_600_000)}h`;
};
const observedAge = (value: unknown, now: number): string => {
  const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? `${age(now - parsed)} ago` : "not yet refreshed";
};
const fit = (value: string, width: number): string => {
  if (width < 1) return ""; const safe = clean(value);
  return safe.length <= width ? safe : width === 1 ? "…" : `${safe.slice(0, width - 1)}…`;
};
const wrap = (value: string, width: number): string[] => {
  const safe = clean(value), size = Math.max(1, width);
  return safe.length
    ? Array.from({ length: Math.ceil(safe.length / size) }, (_, i) => safe.slice(i * size, (i + 1) * size))
    : [""];
};
const json = (value: unknown): string => {
  try { return clean(JSON.stringify(value)); }
  catch { return "unprintable result"; }
};
const endpointKey = (row: Pick<EndpointRow, "host" | "id">): string => `${row.host}\0${row.id}`;
const loopback = (value: unknown): boolean => typeof value === "string" && /^loopback-[ab]-[0-9a-f]{8}@/.test(value);
const unsuccessful = new Set(["failed", "cancelled", "expired", "ambiguous", "unconfirmed"]);
const deliveryToken = /^dlv_[A-Za-z0-9_-]{24}$/;

function tokenFeedback(token: string): string {
  if (deliveryToken.test(token)) return "format valid";
  if ("dlv_".startsWith(token) || /^dlv_[A-Za-z0-9_-]{0,23}$/.test(token)) return "format incomplete";
  return "format invalid";
}

function endpointRows(snapshot?: Obj): EndpointRow[] {
  const local = list(snapshot?.routes).map((row) => ({ id: text(row.id), alias: text(row.alias), provider: text(row.provider),
    host: text(row.host), local: true, ...(typeof row.queueDepth === "number" ? { queueDepth: row.queueDepth } : {}),
    ...(object(row.lastOperation) ? { lastOperation: row.lastOperation } : {}), ...(object(row.codex) ? { codex: row.codex } : {}) }));
  const federation = object(snapshot?.federation) ? snapshot.federation : undefined;
  const remote = list(federation?.nodes).flatMap((node) => {
    const common = { host: text(node.host), local: false as const,
      ...(typeof node.observedAt === "string" ? { observedAt: node.observedAt } : {}),
      ...(typeof node.safeErrorCode === "string" ? { safeErrorCode: node.safeErrorCode } : {}) };
    const routes = list(node.routes);
    return routes.length ? routes.map((row) => ({ ...common, id: text(row.id), alias: text(row.alias),
      provider: text(row.provider), host: text(row.host, common.host) }))
      : [{ ...common, id: "", alias: "No cached endpoints", provider: "-", placeholder: true }];
  });
  return [...local, ...remote];
}
function deliveryRows(snapshot?: Obj): (Obj | DeliverySummary)[] {
  const sorted = list(snapshot?.messages).sort((a, b) => (typeof a.ageMs === "number" ? a.ageMs : Number.MAX_SAFE_INTEGER) -
    (typeof b.ageMs === "number" ? b.ageMs : Number.MAX_SAFE_INTEGER));
  const result: (Obj | DeliverySummary)[] = [];
  for (const row of sorted) {
    const anonymous = typeof row.source !== "string" && typeof row.target !== "string", last = result.at(-1);
    if (anonymous && object(last) && last.summary === true && Array.isArray(last.rows))
      result[result.length - 1] = { summary: true, rows: [...last.rows.filter(object), row] };
    else if (anonymous) result.push({ summary: true, rows: [row] }); else result.push(row);
  }
  return result;
}
function sectionRows(model: TuiModel, width = 80): (Obj | EndpointRow | DeliverySummary | string)[] {
  if (model.section === "endpoints") return endpointRows(model.snapshot);
  if (model.section === "deliveries") return deliveryRows(model.snapshot);
  if (model.section === "result") return model.result ? [`${model.result.label}:`, ...wrap(model.result.value, Math.max(1, width - 2))] : [];
  return list(model.snapshot?.retirements);
}
function operation(row: EndpointRow): string {
  if (!row.lastOperation) return "not yet observed";
  const outcome = text(row.lastOperation.outcome);
  return outcome === "delivered" ? "delivered" : `${outcome} !${text(row.lastOperation.code)}`;
}
function summaryLine(row: DeliverySummary): string {
  const counts = new Map<string, number>();
  for (const item of row.rows) { const state = text(item.state);
    const label = `${state}${unsuccessful.has(state) && item.safeErrorCode ? ` !${text(item.safeErrorCode)}` : ""}`;
    counts.set(label, (counts.get(label) ?? 0) + 1); }
  return `${row.rows.length} unattributed deliveries · ${[...counts].map(([label, count]) => `${label} ${count}`).join(" · ")}`;
}
function lineFor(row: Obj | EndpointRow | DeliverySummary | string, section: Section, now: number, collisions: Set<string>): string {
  if (typeof row === "string") return row;
  if ("summary" in row && row.summary === true) return summaryLine(row as DeliverySummary);
  if (section === "endpoints") { const endpoint = row as EndpointRow;
    const collision = collisions.has(endpoint.alias) ? ` [ambiguous; …${endpoint.id.slice(-8)}]` : "";
    const codex = endpoint.codex ? `  ${text(endpoint.codex.state)}` : "";
    return endpoint.local ? `${endpoint.alias}${collision}  ${endpoint.provider}${codex}  queued ${endpoint.queueDepth ?? 0}  last ${operation(endpoint)}`
      : `SSH ${endpoint.host} · catalog ${observedAge(endpoint.observedAt, now)}${endpoint.safeErrorCode ? ` / ${endpoint.safeErrorCode}` : ""}` +
        ` · ${endpoint.alias}${collision}  ${endpoint.provider}  queue/last not reported`;
  }
  const item = row as Obj;
  if (section === "deliveries") { const state = text(item.state);
    const code = unsuccessful.has(state) && item.safeErrorCode ? ` !${text(item.safeErrorCode)}` : "";
    const source = text(item.source, "unavailable sender"), target = text(item.target, "unavailable recipient");
    return `${age(item.ageMs)} ago  ${state}${code}  ${source} -> ${target}${loopback(source) || loopback(target) ? " (loopback check)" : ""}`;
  }
  const alias = text(item.alias), parsed = typeof item.at === "string" ? Date.parse(item.at) : Number.NaN;
  return `${Number.isFinite(parsed) ? `${age(now - parsed)} ago` : text(item.at)}  ${alias}${loopback(alias) ? " (loopback check)" : ""}`;
}
function collisionAliases(snapshot?: Obj): Set<string> {
  const counts = new Map<string, number>();
  for (const row of endpointRows(snapshot)) if (!row.placeholder) counts.set(row.alias, (counts.get(row.alias) ?? 0) + 1);
  return new Set([...counts].filter(([, count]) => count > 1).map(([alias]) => alias));
}
function retirementLines(row: EndpointRow, width: number): string[] {
  return ["Embassy retirement confirmation", ...wrap(`Host: ${row.host}`, width), ...wrap(`Alias: ${row.alias}`, width), ...wrap(`Endpoint ID: ${row.id}`, width),
    ...wrap(`${row.provider} · queued ${row.queueDepth ?? 0} · last ${operation(row)}`, width),
    ...wrap("queued/reserved work is cancelled, armed work becomes ambiguous, accepted work becomes unconfirmed — cannot be undone.", width),
    "y confirm · N cancel"];
}

/** Pure screen renderer. It emits no ANSI so all dynamic values remain inert. */
export function renderTui(model: Readonly<TuiModel>, columns = 80, rows = 24, now = Date.now()): string {
  const width = Math.max(1, columns || 80), height = Math.max(1, rows || 24);
  if (model.mode === "confirm" && model.retiring) {
    const confirmation = retirementLines(model.retiring, width);
    if (confirmation.length > height) return ["Embassy · terminal too small", "Resize to show the exact endpoint ID and consequences.", "N cancel"]
      .slice(0, height).map((line) => fit(line, width)).join("\n");
    return [...confirmation, ...Array.from({ length: height - confirmation.length }, () => "")]
      .map((line) => fit(line, width)).join("\n");
  }
  if (height < 6 || width < 24) return ["Embassy · terminal too small", "Resize · q quit"]
    .slice(0, height).map((line) => fit(line, width)).join("\n");
  const snapshot = model.snapshot, host = model.host ? ` ${model.host}` : "", lines: string[] = [];
  if (model.error) { const elapsed = model.staleSince ? `, ${age(now - model.staleSince)}` : "";
    lines.push(`Embassy${host} · broker UNREACHABLE (${model.error}${elapsed})`);
    lines.push(`${snapshot ? `Last-known: ${text(snapshot.health, "unknown")} · ledger rev ${snapshot.revision ?? "-"}. ` : ""}Run embassy service status${model.host ? ` on ${model.host}` : ""}.`);
    lines.push("STALE data · not a provider readiness proof");
    if (model.errorDetail) lines.push(...wrap(model.errorDetail, width));
  } else {
    const broker = snapshot ? text(snapshot.health, "unknown") : "not reachable";
    const fault = snapshot?.safeErrorCode ? ` !${text(snapshot.safeErrorCode)}` : "";
    lines.push(`Embassy${host} · broker ${broker}${fault} · ledger rev ${snapshot?.revision ?? "-"}`);
    lines.push(`Updated ${model.snapshotAt ? `${age(now - model.snapshotAt)} ago` : "never"} · not a provider readiness proof`);
  }
  if (model.restarted) lines.push("Ledger revision decreased; broker restarted/reset.");
  if (object(snapshot?.codex)) lines.push(`Codex discovery ${snapshot.codex.complete ? "up to 20 most recent" : "partial"}${snapshot.codex.truncated ? " · truncated" : ""} · ${observedAge(snapshot.codex.observedAt, now)}${snapshot.codex.safeErrorCode ? ` !${text(snapshot.codex.safeErrorCode)}` : ""}`);
  const failed = list(snapshot?.messages).filter((row) => row.state === "failed").length;
  const tabs: Section[] = ["endpoints", "deliveries", "retirements", "result"];
  const tabName = (tab: Section) => tab === "deliveries" && failed ? `deliveries (${failed} failed)` : tab;
  lines.push(tabs.map((tab) => tab === model.section ? `[${tabName(tab)}]` : ` ${tabName(tab)} `).join("  "));
  const source = sectionRows(model, width);
  let selected = Math.max(0, Math.min(model.selected[model.section] ?? 0, Math.max(0, source.length - 1)));
  if (model.section === "endpoints" && model.selectedEndpoint)
    selected = (source as EndpointRow[]).findIndex((row) => endpointKey(row) === model.selectedEndpoint);
  const bodyHeight = Math.max(1, height - 9), start = selected < 0 ? 0
    : Math.max(0, Math.min(selected - Math.floor(bodyHeight / 2), Math.max(0, source.length - bodyHeight)));
  const visible = source.slice(start, start + bodyHeight);
  if (visible.length === 0) lines.push("  No rows.");
  else visible.forEach((row, offset) => lines.push(`${start + offset === selected ? ">" : " "} ${lineFor(row, model.section, now, collisionAliases(snapshot))}`));
  lines.push(`${model.section} ${source.length ? `${selected < 0 ? "-" : selected + 1}/${source.length}` : "0/0"}`);
  if (model.mode === "token")
    lines.push(`Delivery token: ${model.token || "dlv_…"} · ${tokenFeedback(model.token)}`, "Enter look up · Esc cancel");
  else lines.push("Tab/Shift-Tab or 1–4 sections · ↑/↓ j/k g/G select", "r refresh · c check · d delivery · x retire · q quit");
  if (model.actionRunning) lines.push(...wrap(`${model.action ?? "action in progress"} — polling paused`, width - 2).map((line) => `  ${line}`));
  else if (model.action) lines.push(...wrap(model.action, width - 2).map((line) => `  ${line}`));
  while (lines.length < height) lines.push("");
  return lines.slice(0, height).map((line) => fit(line, width)).join("\n");
}

/** Interactive, dependency-free client over the existing broker commands. */
export async function runTui(dependencies: TuiDependencies): Promise<void> {
  const { input, output, call, renderStatus, signal } = dependencies;
  if (!output.isTTY || !input.isTTY) {
    output.write(renderStatus(await call({ method: "list_snapshot", params: {} })));
    return;
  }
  if (signal?.aborted) return;
  const remote = dependencies.remote;
  type Pane = { model: TuiModel; call: typeof call; interval: number; pollInFlight: boolean; actionDepth: number;
    activePoll: Promise<void>; actionTail: Promise<void>; timer?: ReturnType<typeof setTimeout> };
  const hosts = [dependencies.host ?? "local", ...(remote?.hosts ?? [])];
  const panes: Pane[] = hosts.map((host, index) => ({
    model: { host, section: "endpoints", selected: { endpoints: 0, deliveries: 0, retirements: 0 }, mode: "browse", token: "" },
    call: index === 0 ? call : (command) => remote!.call(host, command), interval: index === 0 ? 1_000 : 5_000,
    pollInFlight: false, actionDepth: 0, activePoll: Promise.resolve(), actionTail: Promise.resolve(),
  }));
  let active = 0, model = panes[0]!.model;
  const priorRaw = input.isRaw === true, priorFlowing = input.readableFlowing;
  let closed = false, lastFrame = "";
  let drawTimer: ReturnType<typeof setTimeout> | undefined;
  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => { resolveDone = resolve; });
  const keyInput = new PassThrough();
  const draw = () => {
    if (closed) return;
    const width = output.columns || 80, height = output.rows || 24;
    const overview: string[] = [];
    if (panes.length > 1 && model.mode !== "confirm") {
      overview.push("Hosts: [ / ] switch · each pane reports its own broker");
      const visible = Math.min(4, Math.max(1, height - 10));
      const start = Math.max(0, Math.min(active - 1, panes.length - visible));
      panes.slice(start, start + visible).forEach((pane, offset) => {
        const m = pane.model;
        const state = m.error ? `STALE !${m.error}` : m.snapshot ? text(m.snapshot.health) : "connecting";
        const elapsed = m.snapshotAt === undefined ? "not observed" : `${age(Date.now() - m.snapshotAt)} ago`;
        overview.push(`${start + offset === active ? ">" : " "} ${m.host} · ${state} · ${elapsed}`);
      });
    }
    const frame = [...overview.map((line) => fit(line, width)), renderTui(model, width, Math.max(1, height - overview.length))].join("\n");
    if (frame === lastFrame) return;
    lastFrame = frame;
    output.write(`\x1b[H\x1b[2J${frame}\x1b[0m`);
  };
  const replaceSnapshot = (pane: Pane, value: unknown) => {
    if (!object(value)) throw new Error("CONTROL_INVALID_RESPONSE");
    const model = pane.model;
    const before = typeof model.snapshot?.revision === "number" ? model.snapshot.revision : undefined;
    const after = typeof value.revision === "number" ? value.revision : undefined;
    if (before !== undefined && after !== undefined && after < before) model.restarted = true;
    // A selected host's own rows are authoritative for its pane, not its mirrors.
    model.snapshot = remote ? { ...value, federation: { nodes: [], truncated: false } } : value;
    model.snapshotAt = Date.now(); delete model.staleSince; delete model.error; delete model.errorDetail;
    const endpoints = endpointRows(model.snapshot);
    if (model.selectedEndpoint === undefined && endpoints[0]) model.selectedEndpoint = endpointKey(endpoints[0]);
    const endpointIndex = endpoints.findIndex((row) => endpointKey(row) === model.selectedEndpoint);
    model.selected.endpoints = endpointIndex < 0 ? 0 : endpointIndex;
    for (const section of ["deliveries", "retirements"] as const) {
      const previous = model.section;
      model.section = section;
      model.selected[section] = Math.min(model.selected[section], Math.max(0, sectionRows(model).length - 1));
      model.section = previous;
    }
  };
  const recordFailure = (pane: Pane, error: unknown) => {
    pane.model.staleSince ??= Date.now(); pane.model.error = errorText(error);
    delete pane.model.errorDetail;
    if (object(error) && object(error.detail) && typeof error.detail.detail === "string")
      pane.model.errorDetail = clean(error.detail.detail);
  };
  const snapshot = async (pane: Pane) => {
    if (closed || pane.pollInFlight || pane.actionDepth > 0) return;
    pane.pollInFlight = true;
    pane.activePoll = (async () => {
      try { const result = await pane.call({ method: "list_snapshot", params: {} }); if (!closed) replaceSnapshot(pane, result); }
      catch (error) {
        if (!closed) recordFailure(pane, error);
      } finally {
        pane.pollInFlight = false;
        draw();
      }
    })();
    await pane.activePoll;
  };
  const schedulePoll = (pane: Pane) => {
    if (closed) return;
    pane.timer = setTimeout(async () => {
      await snapshot(pane);
      schedulePoll(pane);
    }, pane.interval);
    pane.timer.unref?.();
  };
  const scheduleDraw = () => {
    if (closed) return;
    drawTimer = setTimeout(() => {
      // Successful local polls already repaint every host's age once per second.
      if (panes[0]!.pollInFlight || panes[0]!.actionDepth > 0 || !panes[0]!.model.snapshot) draw();
      scheduleDraw();
    }, 1_000);
    drawTimer.unref?.();
  };
  const fresh = (pane: Pane) => !pane.model.error && pane.model.snapshotAt !== undefined && Date.now() - pane.model.snapshotAt <= 10_000;
  const queueAction = (label: string, command: BrokerCommand) => {
    const pane = panes[active]!, model = pane.model;
    if (pane.actionDepth > 0) {
      model.action = "An action is already running.";
      draw();
      return;
    }
    pane.actionDepth++;
    model.actionRunning = true;
    model.action = `${label} in progress`;
    draw();
    pane.actionTail = pane.actionTail.then(async () => {
      await pane.activePoll;
      if (closed) {
        pane.actionDepth--;
        return;
      }
      if (pane !== panes[0] && command.method === "retire_route" && !fresh(pane)) {
        pane.actionDepth--; model.actionRunning = false;
        model.action = "retire: wait for a fresh supported owner snapshot"; draw(); return;
      }
      try {
        const result = await pane.call(command);
        if (closed) return;
        model.result = { label, value: json(result) };
        model.previousSection = model.section === "result" ? model.previousSection ?? "endpoints" : model.section;
        model.action = `${label} result ready (4): ${json(result)}`;
        try { const result = await pane.call({ method: "list_snapshot", params: {} }); if (!closed) replaceSnapshot(pane, result); }
        catch (error) {
          if (!closed) recordFailure(pane, error);
        }
      } catch (error) {
        const code = errorText(error), guidance = dependencies.hint?.(code, model.host);
        model.result = { label, value: guidance ? `${code}\n${guidance}` : code };
        model.previousSection = model.section === "result" ? model.previousSection ?? "endpoints" : model.section;
        const disposition = code === "CONTROL_WRITE_OUTCOME_AMBIGUOUS" ? "outcome uncertain" : "refused";
        model.action = `${label} ${disposition} — result ready (4): ${code}${guidance ? ` — ${guidance}` : ""}`;
      } finally {
        pane.actionDepth--;
        model.actionRunning = false;
        draw();
      }
    }, () => {
      pane.actionDepth--;
      model.actionRunning = false;
    });
  };
  const currentEndpoint = (): EndpointRow | undefined => {
    const rows = endpointRows(model.snapshot);
    return model.selectedEndpoint
      ? rows.find((row) => endpointKey(row) === model.selectedEndpoint)
      : rows[model.selected.endpoints];
  };
  const clearAction = () => { if (!model.actionRunning) delete model.action; };
  const select = (next: number | "first" | "last") => {
    const source = sectionRows(model, output.columns || 80);
    const current = model.selected[model.section] ?? 0;
    const index = next === "first" ? 0 : next === "last" ? Math.max(0, source.length - 1)
      : Math.max(0, Math.min(current + next, Math.max(0, source.length - 1)));
    model.selected[model.section] = index;
    if (model.section === "endpoints") {
      const row = source[index] as EndpointRow | undefined;
      if (row) model.selectedEndpoint = endpointKey(row);
      else delete model.selectedEndpoint;
    }
    clearAction();
  };
  const chooseSection = (section: Section) => {
    if (model.section !== "result" && section === "result") model.previousSection = model.section;
    model.section = section;
    clearAction();
  };
  const finish = () => {
    if (closed) return;
    closed = true;
    for (const pane of panes) if (pane.timer) clearTimeout(pane.timer);
    if (drawTimer) clearTimeout(drawTimer);
    input.off("data", onInputData);
    input.off("end", finish);
    input.off("error", finish);
    keyInput.off("keypress", onKeypress);
    keyInput.destroy();
    output.off?.("resize", draw);
    signal?.removeEventListener("abort", finish);
    if (!signal) {
      process.off("SIGINT", finish);
      process.off("SIGTERM", finish);
    }
    try { if (!priorRaw) input.setRawMode?.(false); } catch { /* terminal may already be gone */ }
    try { if (priorFlowing === true) input.resume?.(); else input.pause?.(); } catch { /* input may already be closed */ }
    remote?.close();
    output.write("\x1b[0m\x1b[?25h\x1b[?1049l"); resolveDone(); };
  const onKeypress = (sequence: unknown, details?: { name?: string; ctrl?: boolean; shift?: boolean }) => {
    const key = typeof sequence === "string" ? sequence : "", name = details?.name;
    if (details?.ctrl && name === "c" || (model.mode === "browse" && key === "q")) return finish();
    if (model.mode === "token") {
      if (name === "escape") { model.mode = "browse"; model.token = ""; }
      else if (name === "return" || name === "enter") { const token = model.token; model.token = ""; model.mode = "browse";
        if (deliveryToken.test(token)) queueAction("delivery", { method: "delivery_status", params: { token } });
        else model.action = "Enter a delivery token in the form dlv_<24 characters>.";
      } else if (name === "backspace") model.token = model.token.slice(0, -1);
      else if (/^[\x20-\x7e]+$/.test(key) && model.token.length + key.length <= 28) model.token += key;
      draw(); return;
    }
    if (model.mode === "confirm") { const retiring = model.retiring; model.mode = "browse"; delete model.retiring;
      const visible = retiring ? retirementLines(retiring, output.columns || 80).length <= (output.rows || 24) : false;
      if (key.toLowerCase() === "y" && retiring && visible) queueAction("retire", { method: "retire_route", params: { endpoint: retiring.id } });
      else model.action = key.toLowerCase() === "y" ? "Retirement cancelled: resize to show the exact endpoint ID and consequences." : "Retirement cancelled.";
      draw(); return;
    }
    const sections: Section[] = ["endpoints", "deliveries", "retirements", "result"];
    if ((key === "[" || key === "]") && panes.length > 1) {
      active = (active + (key === "]" ? 1 : -1) + panes.length) % panes.length;
      model = panes[active]!.model;
    } else if ((name === "escape" || key === "\x1b") && model.section === "result") chooseSection(model.previousSection ?? "endpoints");
    else if (name === "tab") { const direction = details?.shift || key === "\x1b[Z" ? -1 : 1;
      chooseSection(sections[(sections.indexOf(model.section) + direction + sections.length) % sections.length]!); }
    else if (/^[1-4]$/.test(key)) chooseSection(sections[Number(key) - 1]!);
    else if (name === "up" || key === "k") select(-1); else if (name === "down" || key === "j") select(1);
    else if (key === "g") select("first"); else if (key === "G") select("last");
    else if (key === "r") queueAction("refresh", { method: "refresh_discovery", params: {} });
    else if (key === "c") queueAction("check", { method: "check", params: {} });
    else if (key === "d") { model.mode = "token"; model.token = ""; clearAction(); }
    else if (key === "x" && model.section === "endpoints") { const selected = currentEndpoint();
      if (active > 0 && !fresh(panes[active]!))
        model.action = "retire: wait for a fresh supported owner snapshot";
      else if (!selected) model.action = "retire: the selected endpoint is no longer present";
      else if (!selected.local) model.action = selected.placeholder ? `${selected.host} has no cached endpoints — press r or run Embassy there`
        : `retire: ${selected.alias} is owned by ${selected.host}; run Embassy there`;
      else { model.retiring = selected; model.mode = "confirm"; delete model.action; }
    }
    draw();
  };
  const onInputData = (chunk: unknown) => { if (!closed) keyInput.write(chunk); };
  emitKeypressEvents(keyInput); keyInput.on("keypress", onKeypress);
  input.on("data", onInputData); input.on("end", finish); input.on("error", finish);
  output.on?.("resize", draw); signal?.addEventListener("abort", finish, { once: true });
  if (!signal) { process.on("SIGINT", finish); process.on("SIGTERM", finish); }
  try { if (!priorRaw) input.setRawMode?.(true); } catch (error) { finish(); throw error; }
  output.write("\x1b[?1049h\x1b[?25l"); draw(); scheduleDraw();
  for (const pane of panes) void snapshot(pane).then(() => schedulePoll(pane));
  await done;
}
