import wrapAnsi from "wrap-ansi";

export type Obj = Record<string, unknown>;
export type Section = "endpoints" | "deliveries" | "retirements" | "result";
export type Mode = "browse" | "token" | "confirm";
export type EndpointRow = Readonly<{
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
export type DeliverySummary = Readonly<{ summary: true; rows: readonly Obj[] }>;
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
  hosts?: readonly Readonly<{ host: string; state: string; selected: boolean }>[];
};

export const object = (value: unknown): value is Obj => !!value && typeof value === "object" && !Array.isArray(value);
export const list = (value: unknown): Obj[] => Array.isArray(value) ? value.filter(object) : [];
export const text = (value: unknown, fallback = "not reported"): string =>
  typeof value === "string" && value.length > 0 ? value : fallback;

const ansi = /(?:\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[P^_X][\s\S]*?\u001b\\|\u001b\[[0-?]*[ -/]*[@-~]|\u001b[@-_])/g;
export const clean = (value: unknown): string => text(value, "").replace(ansi, "")
  .replace(/[\p{Cc}\p{Cf}]/gu, (character) => character === "\u200d" ? character
    : character === "\n" || character === "\r" || character === "\t" ? " " : "?");

export const errorText = (error: unknown): string => {
  if (object(error) && typeof error.code === "string") return clean(error.code);
  if (error instanceof Error && typeof (error as Error & { code?: unknown }).code === "string")
    return clean((error as Error & { code: string }).code);
  return "CONTROL_UNAVAILABLE";
};
export const age = (milliseconds: unknown): string => {
  const ms = typeof milliseconds === "number" && Number.isFinite(milliseconds) ? Math.max(0, milliseconds) : 0;
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${Math.floor(ms / 1_000)}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
  return `${Math.floor(ms / 3_600_000)}h`;
};
export const json = (value: unknown): string => {
  try { return clean(JSON.stringify(value)); }
  catch { return "unprintable result"; }
};

export const endpointKey = (row: Pick<EndpointRow, "host" | "id">): string => `${row.host}\0${row.id}`;
const loopback = (value: unknown): boolean => typeof value === "string" && /^loopback-[ab]-[0-9a-f]{8}@/.test(value);
export const unsuccessful = new Set(["failed", "cancelled", "expired", "ambiguous", "unconfirmed"]);
export const deliveryToken = /^dlv_[A-Za-z0-9_-]{24}$/;

export function tokenFeedback(token: string): string {
  if (deliveryToken.test(token)) return "format valid";
  if ("dlv_".startsWith(token) || /^dlv_[A-Za-z0-9_-]{0,23}$/.test(token)) return "format incomplete";
  return "format invalid";
}

export const groups = ["Working", "Waiting", "Faulted", "Ready", "Dormant", "Not reporting", "Cached"] as const;
export function endpointGroup(row: EndpointRow): number {
  if (!row.local) return 6;
  return ({ busy: 0, waiting: 1, systemError: 2, idle: 3, dormant: 4 } as Record<string, number>)[String(row.codex?.state)] ?? 5;
}

export function endpointRows(snapshot?: Obj): EndpointRow[] {
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
  return [...local, ...remote].sort((a, b) => endpointGroup(a) - endpointGroup(b));
}

function deliveryRows(snapshot?: Obj): (Obj | DeliverySummary)[] {
  const sorted = list(snapshot?.messages).sort((a, b) => (typeof a.ageMs === "number" ? a.ageMs : Number.MAX_SAFE_INTEGER) -
    (typeof b.ageMs === "number" ? b.ageMs : Number.MAX_SAFE_INTEGER));
  const result: (Obj | DeliverySummary)[] = [];
  for (const row of sorted) {
    const anonymous = typeof row.source !== "string" && typeof row.target !== "string", last = result.at(-1);
    if (object(last) && last.summary === true && anonymous && Array.isArray(last.rows))
      result[result.length - 1] = { summary: true, rows: [...last.rows.filter(object), row] };
    else if (anonymous) result.push({ summary: true, rows: [row] }); else result.push(row);
  }
  return result;
}

export function sectionRows(model: TuiModel, width = 80): (Obj | EndpointRow | DeliverySummary | string)[] {
  if (model.section === "endpoints") return endpointRows(model.snapshot);
  if (model.section === "deliveries") return deliveryRows(model.snapshot);
  if (model.section === "result") {
    if (!model.result) return [];
    let value = model.result.value;
    try { value = JSON.stringify(JSON.parse(value), null, 2); } catch { /* A refusal includes plain operator guidance. */ }
    return [`${model.result.label}:`, ...value.split("\n").flatMap((line) =>
      wrapAnsi(clean(line), Math.max(1, width - 2), { hard: true, trim: false }).split("\n"))];
  }
  return list(model.snapshot?.retirements);
}

export function operation(row: EndpointRow): string {
  if (!row.lastOperation) return "not yet observed";
  const outcome = text(row.lastOperation.outcome);
  return outcome === "delivered" ? "delivered" : `${outcome} !${text(row.lastOperation.code)}`;
}
export function collisionAliases(snapshot?: Obj): Set<string> {
  const counts = new Map<string, number>();
  for (const row of endpointRows(snapshot)) if (!row.placeholder) counts.set(row.alias, (counts.get(row.alias) ?? 0) + 1);
  return new Set([...counts].filter(([, count]) => count > 1).map(([alias]) => alias));
}

export function summaryLine(row: DeliverySummary): string {
  const counts = new Map<string, number>();
  for (const item of row.rows) {
    const state = text(item.state), label = `${state}${unsuccessful.has(state) && item.safeErrorCode ? ` !${text(item.safeErrorCode)}` : ""}`;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return `${row.rows.length} unattributed deliveries · ${[...counts].map(([label, count]) => `${label} ${count}`).join(" · ")}`;
}
export const isLoopback = loopback;

export function modalFits(model: Readonly<TuiModel>, width: number, height: number): boolean {
  if (width < 48) return false;
  const inner = Math.min(78, width - 4) - 6;
  const count = (value: string) => wrapAnsi(clean(value), inner, { hard: true, trim: false }).split("\n").length;
  if (model.mode === "token") return height >= 11;
  if (model.mode !== "confirm" || !model.retiring) return true;
  const row = model.retiring;
  const rows = 11 + count(`Host: ${row.host}`) + count(`Alias: ${row.alias}`) + count(row.id) +
    count(`${row.provider} · queue ${row.queueDepth ?? 0} · last ${operation(row)}`) +
    count("queued/reserved work is cancelled, armed work becomes ambiguous, accepted work becomes unconfirmed — cannot be undone.");
  return rows <= height;
}
