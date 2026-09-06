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
  signal?: AbortSignal;
}>;

type Obj = Record<string, unknown>;
type Section = "endpoints" | "deliveries" | "retirements" | "result";
type Mode = "browse" | "token" | "confirm";
type EndpointRow = Readonly<{ id: string; alias: string; provider: string; host: string; local: boolean;
  queueDepth?: number; lastOperation?: Obj; observedAt?: string; safeErrorCode?: string; placeholder?: boolean }>;
export type TuiModel = {
  snapshot?: Obj;
  snapshotAt?: number;
  staleSince?: number;
  error?: string;
  action?: string;
  section: Section;
  selected: Record<Exclude<Section, "result">, number> & Partial<Record<"result", number>>;
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
  return Number.isFinite(parsed) ? `${age(now - parsed)} ago` : "not yet observed";
};
const fit = (value: string, width: number): string => {
  if (width < 1) return "";
  const safe = clean(value);
  return safe.length <= width ? safe : width === 1 ? "…" : `${safe.slice(0, width - 1)}…`;
};
const wrap = (value: string, width: number): string[] => {
  const safe = clean(value), size = Math.max(1, width);
  return safe.length ? Array.from({ length: Math.ceil(safe.length / size) }, (_, index) => safe.slice(index * size, (index + 1) * size)) : [""];
};
const json = (value: unknown): string => {
  try { return clean(JSON.stringify(value)); } catch { return "unprintable result"; }
};

function endpointRows(snapshot?: Obj): EndpointRow[] {
  const local = list(snapshot?.routes).map((row) => ({
    id: text(row.id), alias: text(row.alias), provider: text(row.provider), host: text(row.host), local: true,
    ...(typeof row.queueDepth === "number" ? { queueDepth: row.queueDepth } : {}),
    ...(object(row.lastOperation) ? { lastOperation: row.lastOperation } : {}),
  }));
  const federation = object(snapshot?.federation) ? snapshot.federation : undefined;
  const remote = list(federation?.nodes).flatMap((node) => {
    const common = {
      host: text(node.host), local: false as const,
      ...(typeof node.observedAt === "string" ? { observedAt: node.observedAt } : {}),
      ...(typeof node.safeErrorCode === "string" ? { safeErrorCode: node.safeErrorCode } : {}),
    };
    const routes = list(node.routes);
    return routes.length ? routes.map((row) => ({ ...common,
      id: text(row.id), alias: text(row.alias), provider: text(row.provider), host: text(row.host, common.host),
    })) : [{ ...common, id: "", alias: "No cached endpoints", provider: "-", placeholder: true }];
  });
  return [...local, ...remote];
}

function sectionRows(model: TuiModel, width = 80): (Obj | EndpointRow | string)[] {
  if (model.section === "endpoints") return endpointRows(model.snapshot);
  if (model.section === "result") return model.result
    ? [`${model.result.label}:`, ...wrap(model.result.value, Math.max(1, width - 2))] : [];
  return list(model.snapshot?.[model.section === "deliveries" ? "messages" : "retirements"]);
}

function lineFor(row: Obj | EndpointRow | string, section: Section, now: number): string {
  if (typeof row === "string") return row;
  if (section === "endpoints") {
    const endpoint = row as EndpointRow;
    const operation = endpoint.lastOperation
      ? `${text(endpoint.lastOperation.outcome)} / ${text(endpoint.lastOperation.code)}` : "not yet observed";
    return endpoint.local
      ? `${endpoint.alias}  ${endpoint.provider}  queue ${endpoint.queueDepth ?? 0}  last ${operation}`
      : `SSH ${endpoint.host} · catalog ${observedAge(endpoint.observedAt, now)}` +
        `${endpoint.safeErrorCode ? ` / ${endpoint.safeErrorCode}` : ""} · ${endpoint.alias}  ${endpoint.provider}  queue/last not reported`;
  }
  const item = row as Obj;
  if (section === "deliveries") {
    return `${text(item.source, "retired sender")} -> ${text(item.target, "remote/retired recipient")}  ${text(item.state)}` +
      `${item.safeErrorCode ? ` / ${text(item.safeErrorCode)}` : ""}  ${age(item.ageMs)} ago`;
  }
  return `${text(item.alias)}  ${text(item.at)}`;
}

/** Pure screen renderer. It emits no ANSI so all dynamic values remain inert. */
export function renderTui(model: Readonly<TuiModel>, columns = 80, rows = 24, now = Date.now()): string {
  const width = Math.max(1, columns || 80), height = Math.max(1, rows || 24);
  if (model.mode === "confirm" && model.retiring) {
    const confirmation = ["Embassy retirement confirmation", ...wrap(`Alias: ${model.retiring.alias}`, width),
      ...wrap(`Endpoint ID: ${model.retiring.id}`, width), "y confirm · N cancel"];
    if (confirmation.length > height) return ["Embassy · terminal too small", "Resize to show the exact endpoint ID.", "N cancel"]
      .slice(0, height).map((line) => fit(line, width)).join("\n");
    return [...confirmation, ...Array.from({ length: height - confirmation.length }, () => "")]
      .map((line) => fit(line, width)).join("\n");
  }
  if (height < 6 || width < 24) return ["Embassy · terminal too small", "Resize · q quit"]
    .slice(0, height).map((line) => fit(line, width)).join("\n");
  const snapshot = model.snapshot;
  const lines: string[] = [];
  const health = snapshot ? text(snapshot.health, "unknown") : "unavailable";
  const fault = snapshot?.safeErrorCode ? ` / ${clean(snapshot.safeErrorCode)}` : "";
  lines.push(`Embassy  ${model.error ? "last-known broker" : "broker"} ${health}${fault}  rev ${snapshot?.revision ?? "-"}`);
  if (model.error) lines.push(`STALE${model.staleSince ? ` ${age(now - model.staleSince)}` : ""}: ${model.error}`);
  else lines.push(`Updated ${model.snapshotAt ? `${age(now - model.snapshotAt)} ago` : "never"} · not a provider readiness proof`);
  const tabs: Section[] = ["endpoints", "deliveries", "retirements", "result"];
  lines.push(tabs.map((tab) => tab === model.section ? `[${tab}]` : ` ${tab} `).join("  "));

  const source = sectionRows(model, width);
  const selected = Math.max(0, Math.min(model.selected[model.section] ?? 0, Math.max(0, source.length - 1)));
  const bodyHeight = Math.max(1, height - 8);
  const start = Math.max(0, Math.min(selected - Math.floor(bodyHeight / 2), Math.max(0, source.length - bodyHeight)));
  const visible = source.slice(start, start + bodyHeight);
  if (visible.length === 0) lines.push("  No rows.");
  else visible.forEach((row, offset) => lines.push(`${start + offset === selected ? ">" : " "} ${lineFor(row, model.section, now)}`));

  if (model.mode === "token") lines.push(`Delivery token: ${"•".repeat(Math.min(model.token.length, 32))}`, "Enter look up · Esc cancel");
  else lines.push("Tab sections · ↑/↓ or j/k select · r refresh · c check", "d delivery · x retire · q quit");
  if (model.action) lines.push(model.action);
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
  const model: TuiModel = { section: "endpoints", selected: { endpoints: 0, deliveries: 0, retirements: 0 },
    mode: "browse", token: "" };
  const priorRaw = input.isRaw === true;
  const priorFlowing = input.readableFlowing;
  let closed = false, pollInFlight = false, actionDepth = 0;
  let activePoll: Promise<void> = Promise.resolve();
  let actionTail: Promise<void> = Promise.resolve();
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => { resolveDone = resolve; });
  const keyInput = new PassThrough();

  const draw = () => {
    if (closed) return;
    output.write(`\x1b[H\x1b[2J${renderTui(model, output.columns, output.rows)}\x1b[0m`);
  };
  const replaceSnapshot = (value: unknown) => {
    if (!object(value)) throw new Error("CONTROL_INVALID_RESPONSE");
    model.snapshot = value; model.snapshotAt = Date.now(); delete model.staleSince; delete model.error;
    for (const section of ["endpoints", "deliveries", "retirements"] as const) {
      const previous = model.section; model.section = section;
      model.selected[section] = Math.min(model.selected[section], Math.max(0, sectionRows(model).length - 1));
      model.section = previous;
    }
  };
  const snapshot = async () => {
    if (closed || pollInFlight || actionDepth > 0) return;
    pollInFlight = true;
    activePoll = (async () => {
      try { replaceSnapshot(await call({ method: "list_snapshot", params: {} })); }
      catch (error) { model.staleSince ??= Date.now(); model.error = errorText(error); }
      finally { pollInFlight = false; draw(); }
    })();
    await activePoll;
  };
  const schedulePoll = () => {
    if (closed) return;
    pollTimer = setTimeout(async () => { await snapshot(); schedulePoll(); }, 1_000);
    pollTimer.unref?.();
  };
  const queueAction = (label: string, command: BrokerCommand) => {
    if (actionDepth > 0) { model.action = "An action is already running."; draw(); return; }
    actionDepth++;
    actionTail = actionTail.then(async () => {
      await activePoll;
      if (closed) { actionDepth--; return; }
      model.action = `${label}…`; draw();
      try {
        const result = await call(command);
        if (closed) return;
        model.result = { label, value: json(result) }; model.section = "result"; model.selected.result = 0;
        delete model.action;
        try { replaceSnapshot(await call({ method: "list_snapshot", params: {} })); }
        catch (error) { model.staleSince ??= Date.now(); model.error = errorText(error); }
      } catch (error) {
        model.result = { label, value: errorText(error) }; model.section = "result"; model.selected.result = 0;
        delete model.action;
      }
      finally { actionDepth--; draw(); }
    }, () => { actionDepth--; });
  };
  const select = (delta: number) => {
    const count = sectionRows(model, output.columns || 80).length;
    model.selected[model.section] = Math.max(0, Math.min((model.selected[model.section] ?? 0) + delta, Math.max(0, count - 1)));
  };
  const finish = () => {
    if (closed) return;
    closed = true;
    if (pollTimer) clearTimeout(pollTimer);
    input.off("data", onInputData); input.off("end", finish); input.off("error", finish);
    keyInput.off("keypress", onKeypress); keyInput.destroy();
    output.off?.("resize", draw); signal?.removeEventListener("abort", finish);
    if (!signal) { process.off("SIGINT", finish); process.off("SIGTERM", finish); }
    try { if (!priorRaw) input.setRawMode?.(false); } catch { /* terminal may already be gone */ }
    try { if (priorFlowing === true) input.resume?.(); else input.pause?.(); } catch { /* input may already be closed */ }
    output.write("\x1b[0m\x1b[?25h\x1b[?1049l");
    resolveDone();
  };
  const onKeypress = (sequence: unknown, details?: { name?: string; ctrl?: boolean }) => {
    const key = typeof sequence === "string" ? sequence : "";
    const name = details?.name;
    if (details?.ctrl && name === "c" || (model.mode === "browse" && key === "q")) return finish();
    if (model.mode === "token") {
      if (name === "escape") { model.mode = "browse"; model.token = ""; }
      else if (name === "return" || name === "enter") {
        const token = model.token; model.token = ""; model.mode = "browse";
        if (/^dlv_[A-Za-z0-9_-]{24}$/.test(token)) queueAction("delivery", { method: "delivery_status", params: { token } });
        else model.action = "Enter a delivery token in the form dlv_<24 characters>.";
      } else if (name === "backspace") model.token = model.token.slice(0, -1);
      else if (/^[\x20-\x7e]+$/.test(key) && model.token.length + key.length <= 28) model.token += key;
      draw(); return;
    }
    if (model.mode === "confirm") {
      const retiring = model.retiring; model.mode = "browse"; delete model.retiring;
      const confirmationLines = retiring ? 3 + wrap(`Alias: ${retiring.alias}`, output.columns || 80).length +
        wrap(`Endpoint ID: ${retiring.id}`, output.columns || 80).length : Number.POSITIVE_INFINITY;
      if (key.toLowerCase() === "y" && retiring && confirmationLines <= (output.rows || 24))
        queueAction("retire", { method: "retire_route", params: { endpoint: retiring.id } });
      else if (key.toLowerCase() === "y") model.action = "Retirement cancelled: resize to show the exact endpoint ID.";
      else model.action = "Retirement cancelled.";
      draw(); return;
    }
    if (name === "tab") {
      const sections: Section[] = ["endpoints", "deliveries", "retirements", "result"];
      model.section = sections[(sections.indexOf(model.section) + 1) % sections.length]!;
    } else if (name === "up" || key === "k") select(-1);
    else if (name === "down" || key === "j") select(1);
    else if (key === "r") queueAction("refresh", { method: "refresh_discovery", params: {} });
    else if (key === "c") queueAction("check", { method: "check", params: {} });
    else if (key === "d") { model.mode = "token"; model.token = ""; delete model.action; }
    else if (key === "x" && model.section === "endpoints") {
      const selected = endpointRows(model.snapshot)[model.selected.endpoints];
      if (!selected) model.action = "retire: no endpoint selected";
      else if (!selected.local) model.action = `retire: ${selected.placeholder ? "no endpoint is selected" : `${selected.alias} is owned by ${selected.host}; run Embassy there`}`;
      else { model.retiring = selected; model.mode = "confirm"; delete model.action; }
    }
    draw();
  };

  const onInputData = (chunk: unknown) => { if (!closed) keyInput.write(chunk); };
  emitKeypressEvents(keyInput);
  keyInput.on("keypress", onKeypress);
  input.on("data", onInputData); input.on("end", finish); input.on("error", finish);
  output.on?.("resize", draw); signal?.addEventListener("abort", finish, { once: true });
  if (!signal) { process.on("SIGINT", finish); process.on("SIGTERM", finish); }
  try { if (!priorRaw) input.setRawMode?.(true); }
  catch (error) { finish(); throw error; }
  output.write("\x1b[?1049h\x1b[?25l");
  await snapshot();
  schedulePoll();
  await done;
}
