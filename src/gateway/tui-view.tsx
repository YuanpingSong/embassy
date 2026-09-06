import React from "react";
import { Box, Text } from "ink";
import stringWidth from "string-width";
import {
  age, clean, collisionAliases, endpointGroup, endpointKey, groups, isLoopback,
  list, modalFits, object, operation, sectionRows, summaryLine, text, tokenFeedback,
  unsuccessful, type DeliverySummary, type EndpointRow, type Obj, type Section, type TuiModel,
} from "./tui-model.js";

export type TuiViewProps = Readonly<{ model: Readonly<TuiModel>; columns: number; rows: number; now: number; color: boolean }>;
type Tone = "plain" | "good" | "busy" | "waiting" | "dormant" | "bad";

function tone(value: string): Tone {
  if (["healthy", "idle", "ready", "delivered", "ok"].includes(value)) return "good";
  if (["busy", "working", "queued", "reserved", "armed", "accepted"].includes(value)) return "busy";
  if (value === "waiting") return "waiting";
  if (["dormant", "cached", "unknown"].includes(value)) return "dormant";
  if (value === "stale") return "busy";
  if (unsuccessful.has(value) || ["unreachable", "not reachable", "degraded", "systemError"].includes(value)) return "bad";
  return "plain";
}

function ToneText({ children, value, color, bold = false, inverse = false, dim = false, wrap = "truncate-end" }:
  React.PropsWithChildren<{ value?: string; color: boolean; bold?: boolean; inverse?: boolean; dim?: boolean; wrap?: "truncate-end" | "wrap" }>) {
  const semantic = tone(value ?? "");
  const foreground = !color ? undefined : semantic === "good" ? "green" : semantic === "busy" ? "yellow"
    : semantic === "waiting" ? "magenta" : semantic === "bad" ? "red" : undefined;
  return <Text {...(foreground ? { color: foreground } : {})} bold={color && bold} inverse={color && inverse}
    dimColor={color && (dim || semantic === "dormant" || value === "stale")} {...(wrap ? { wrap } : {})}>{children}</Text>;
}

type Cell = { value: string; width: number; tone?: string; bold?: boolean; dim?: boolean; right?: boolean };
const graphemes = new Intl.Segmenter("en", { granularity: "grapheme" });
function padded(value: string, width: number, right = false): string {
  const safe = clean(value); let output = safe;
  if (stringWidth(safe) > width) {
    output = "";
    for (const { segment } of graphemes.segment(safe)) {
      if (stringWidth(output + segment) > width - 1) break;
      output += segment;
    }
    output += width > 0 ? "…" : "";
  }
  const space = " ".repeat(Math.max(0, width - stringWidth(output)));
  return right ? space + output : output + space;
}
function DataLine({ cells, selected, color, width }: { cells: Cell[]; selected: boolean; color: boolean; width: number }) {
  return <Box height={1} flexShrink={0} width={width}><Text inverse={selected && color}>
    {selected ? "> " : "  "}{cells.map((cell, index) => <ToneText key={index} color={color}
      {...(!selected && cell.tone ? { value: cell.tone } : {})} bold={cell.bold ?? false} dim={!selected && (cell.dim ?? false)}>
      {index < cells.length - 1 ? `${padded(cell.value, Math.max(0, cell.width - 1), cell.right)} ` : padded(cell.value, cell.width, cell.right)}
    </ToneText>)}
  </Text></Box>;
}
function endpointWidths(width: number) {
  const alias = Math.min(48, Math.max(10, width - 63));
  return { alias, outcome: Math.max(1, width - alias - 27) };
}

function Rule({ width, color }: { width: number; color: boolean }) {
  return <ToneText color={color} dim>{"─".repeat(Math.max(1, width))}</ToneText>;
}

function HostTabs({ model, color, width }: { model: Readonly<TuiModel>; color: boolean; width: number }) {
  if (!model.hosts || model.hosts.length < 2) return null;
  const count = Math.max(1, Math.floor(width / 24)), active = Math.max(0, model.hosts.findIndex((host) => host.selected));
  const start = Math.max(0, Math.min(active - 1, model.hosts.length - count));
  return <Box flexShrink={0} height={1} overflow="hidden">{model.hosts.slice(start, start + count).map((host) => <Box key={host.host} width={Math.floor(width / Math.min(count, model.hosts!.length))} paddingRight={1} flexShrink={0}>
    <ToneText color={color} value={host.state}>● </ToneText>
    <ToneText color={color} value={host.state} bold={host.selected} wrap="truncate-end">
      {host.selected ? `[${clean(host.host)} · ${clean(host.state)}]` : `${clean(host.host)} · ${clean(host.state)}`}
    </ToneText>
  </Box>)}</Box>;
}

function Header({ model, width, now, color }: { model: Readonly<TuiModel>; width: number; now: number; color: boolean }) {
  const snapshot = model.snapshot;
  const health = model.error ? "UNREACHABLE" : snapshot ? text(snapshot.health, "unknown") : "not reachable";
  const elapsed = model.snapshotAt === undefined ? "never" : now - model.snapshotAt < 1_000 ? "just now" : `${age(now - model.snapshotAt)} ago`;
  return <Box flexDirection="column" flexShrink={0}>
    <HostTabs model={model} color={color} width={width} />
    <Box height={1}>
      <Box width={Math.max(12, width - 43)}><ToneText color={color} bold wrap="truncate-end">Embassy {clean(model.host ?? "local")}</ToneText></Box>
      <Box width={25}><ToneText color={color} value={health.toLowerCase()}>broker {clean(health)}</ToneText></Box>
      <Box width={18}><ToneText color={color} dim wrap="truncate-end">ledger rev {String(snapshot?.revision ?? "-")}</ToneText></Box>
    </Box>
    <Box height={1} flexShrink={0}><ToneText color={color} dim wrap="truncate-end">Updated {elapsed}
      {object(snapshot?.codex) ? ` · Codex discovery ${snapshot.codex.complete ? "up to 20 most recent" : "partial"}${snapshot.codex.truncated ? " · truncated" : ""} · ${observationAge(snapshot.codex.observedAt, now)}${snapshot.codex.safeErrorCode ? ` !${clean(text(snapshot.codex.safeErrorCode))}` : ""}` : ""}
    </ToneText></Box>
    {model.error ? <>
      <ToneText color={color} value="stale">STALE {age(now - (model.staleSince ?? now))} !{clean(model.error)}</ToneText>
      <ToneText color={color} dim>{snapshot ? `Last-known: ${clean(text(snapshot.health))}. ` : ""}Run embassy service status on {clean(model.host ?? "local")}.</ToneText>
      {model.errorDetail ? <ToneText color={color} value="failed">{clean(model.errorDetail)}</ToneText> : null}
    </> : snapshot?.safeErrorCode ? <ToneText color={color} value="failed">!{clean(text(snapshot.safeErrorCode))}</ToneText> : null}
    {model.restarted ? <ToneText color={color} value="busy">Ledger revision decreased; broker restarted/reset.</ToneText> : null}
    <ToneText color={color} dim>{padded("── not a provider readiness proof ", width).replace(/ +$/, (spaces) => " " + "─".repeat(Math.max(0, spaces.length - 1)))}</ToneText>
  </Box>;
}

function observationAge(value: unknown, now: number): string {
  const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? `${age(now - parsed)} ago` : "not yet refreshed";
}

function SectionTabs({ model, color }: { model: Readonly<TuiModel>; color: boolean }) {
  const failed = list(model.snapshot?.messages).filter((row) => row.state === "failed").length;
  const tabs: Section[] = ["endpoints", "deliveries", "retirements", "result"];
  return <Box flexShrink={0}>{tabs.map((section, index) => {
    const selected = model.section === section;
    const label = `${index + 1} ${section}`;
    return <Box key={section} marginRight={2}><ToneText color={color} bold={selected} dim={!selected}>
      {selected ? `[${label}` : label}
    </ToneText>{section === "deliveries" && failed ? <ToneText color={color} value="failed"> ({failed} failed)</ToneText> : null}
    {selected ? <ToneText color={color} bold>]</ToneText> : null}</Box>;
  })}</Box>;
}

function EndpointLine({ row, selected, collisions, color, now, width }: { row: EndpointRow; selected: boolean; collisions: Set<string>; color: boolean; now: number; width: number }) {
  const state = row.local ? text(row.codex?.state, "unknown") : row.safeErrorCode ? "stale" : "cached";
  const alias = clean(row.alias), collision = collisions.has(row.alias);
  const sizes = endpointWidths(width), outcome = text(row.lastOperation?.outcome, "");
  return <Box flexDirection="column">
    <DataLine selected={selected} color={color} width={width} cells={[
      { value: state, width: 12, tone: state }, { value: alias, width: sizes.alias, bold: true },
      { value: row.provider, width: 7, dim: true }, { value: row.local ? String(row.queueDepth ?? 0) : "—", width: 6, right: true, dim: true },
      { value: row.local ? operation(row) : "not reported", width: sizes.outcome,
        tone: outcome === "failed" || outcome === "delivered" ? outcome : "", dim: !["failed", "delivered"].includes(outcome) },
    ]} />
    {collision ? <Box paddingLeft={14} height={1}><ToneText color={color} dim wrap="truncate-end">ambiguous name · endpoint …{clean(row.id.slice(-8))}</ToneText></Box> : null}
    {!row.local ? <Box paddingLeft={14} height={1}><ToneText color={color} value={row.safeErrorCode ? "stale" : "dormant"} dim wrap="truncate-end">
      SSH {clean(row.host)} · catalog {observationAge(row.observedAt, now)}
      {row.safeErrorCode ? ` !${clean(row.safeErrorCode)}` : ""} · queue/last not reported
    </ToneText></Box> : null}
  </Box>;
}

function DeliveryLine({ row, selected, color, width }: { row: Obj | DeliverySummary; selected: boolean; color: boolean; width: number }) {
  if ((row as DeliverySummary).summary === true)
    return <DataLine selected={selected} color={color} width={width} cells={[{ value: summaryLine(row as DeliverySummary), width: width - 2,
      tone: (row as DeliverySummary).rows.some((item) => unsuccessful.has(String(item.state))) ? "failed" : "" }]} />;
  const item = row as Obj;
  const state = text(item.state), fault = unsuccessful.has(state) && item.safeErrorCode ? ` !${clean(text(item.safeErrorCode))}` : "";
  const source = clean(text(item.source, "unavailable sender")), target = clean(text(item.target, "unavailable recipient"));
  return <Box flexDirection="column" flexShrink={0}>
    <DataLine selected={selected} color={color} width={width} cells={[
      { value: `${age(item.ageMs)} ago`, width: 10, right: true, dim: true }, { value: state, width: 13, tone: state },
      { value: `${source} -> ${target}${isLoopback(source) || isLoopback(target) ? " (loopback check)" : ""}`, width: width - 25, bold: true },
    ]} />
    {fault ? <Box paddingLeft={25} height={1}><ToneText color={color} value="failed" wrap="truncate-end">{fault.trim()}</ToneText></Box> : null}
  </Box>;
}

type Entry = Readonly<{ key: string; index?: number; height: number; node: React.ReactNode }>;
function content(model: Readonly<TuiModel>, color: boolean, now: number, width: number): Entry[] {
  const rows = sectionRows(model, width), selected = selectedIndex(model, rows), collisions = collisionAliases(model.snapshot);
  const entries: Entry[] = [];
  if (model.section === "endpoints") {
    let prior = -1;
    for (const [index, item] of (rows as EndpointRow[]).entries()) {
      const group = endpointGroup(item);
      if (group !== prior) {
        const count = (rows as EndpointRow[]).filter((row) => endpointGroup(row) === group).length;
        entries.push({ key: `group-${group}`, height: 1, node: <ToneText color={color} bold>{groups[group]} ({count})</ToneText> });
        prior = group;
      }
      entries.push({ key: `${endpointKey(item)}\0${index}`, index, height: 1 + Number(collisions.has(item.alias)) + Number(!item.local),
        node: <EndpointLine row={item} selected={index === selected} collisions={collisions} color={color} now={now} width={width} /> });
    }
  } else if (model.section === "deliveries") {
    rows.forEach((row, index) => entries.push({ key: `delivery-${index}`, index,
      height: object(row) && !(row as Obj).summary && unsuccessful.has(String((row as Obj).state)) && (row as Obj).safeErrorCode ? 2 : 1,
      node: <DeliveryLine row={row as Obj | DeliverySummary} selected={index === selected} color={color} width={width} /> }));
  } else if (model.section === "retirements") {
    rows.forEach((row, index) => {
      const item = row as Obj, alias = text(item.alias), at = Date.parse(String(item.at));
      entries.push({ key: `retirement-${index}`, index, height: 1,
        node: <DataLine selected={index === selected} color={color} width={width} cells={[
          { value: Number.isFinite(at) ? `${age(now - at)} ago` : text(item.at), width: 11, right: true, dim: true },
          { value: alias + (isLoopback(alias) ? " (loopback check)" : ""), width: width - 13, bold: !isLoopback(alias), dim: isLoopback(alias) },
        ]} /> });
    });
  } else if (model.result) {
    rows.forEach((row, index) => {
      const state = /"(?:state|status|health|outcome)":\s*"([a-zA-Z]+)"/.exec(String(row))?.[1];
      entries.push({ key: `result-${index}`, index, height: 1,
        node: <ToneText color={color} {...(state ? { value: state } : {})} bold={index === 0}>{clean(row)}</ToneText> });
    });
  }
  return entries;
}

function selectedIndex(model: Readonly<TuiModel>, rows = sectionRows(model)): number {
  if (model.section === "endpoints" && model.selectedEndpoint)
    return (rows as EndpointRow[]).findIndex((row) => endpointKey(row) === model.selectedEndpoint);
  return Math.max(0, Math.min(model.selected[model.section] ?? 0, Math.max(0, rows.length - 1)));
}

function viewport(all: Entry[], focus: number, height: number) {
  let start = 0, end = 0;
  while (start < all.length) {
    let remaining = height - Number(all.slice(0, start).some((entry) => entry.index !== undefined));
    end = start;
    while (end < all.length && all[end]!.height <= remaining) { remaining -= all[end]!.height; end++; }
    if (end < all.length && remaining === 0) end--;
    while (end > start && all[end - 1]!.index === undefined) end--;
    if (focus < 0 || focus < end || start >= focus) break;
    start++;
  }
  const above = all.slice(0, start).filter((entry) => entry.index !== undefined).length;
  const below = all.slice(end).filter((entry) => entry.index !== undefined).length;
  return { entries: all.slice(start, end), above, below };
}

function DialogContent({ model, columns, color }: { model: Readonly<TuiModel>; columns: number; color: boolean }) {
  const retirement = model.mode === "confirm" ? model.retiring : undefined;
  return <Box width={Math.min(78, columns - 4)} borderStyle="round" borderColor={color ? "gray" : undefined}
      paddingX={2} paddingY={1} flexDirection="column">
      <ToneText color={color} bold>{retirement ? "Retire endpoint" : "Look up delivery"}</ToneText>
      <Box height={1} />
      {retirement ? <>
        <ToneText color={color} bold wrap="wrap">Host: {clean(retirement.host)}</ToneText>
        <ToneText color={color} bold wrap="wrap">Alias: {clean(retirement.alias)}</ToneText>
        <ToneText color={color} dim>Endpoint ID</ToneText>
        <ToneText color={color} bold wrap="wrap">{clean(retirement.id)}</ToneText>
        <Box height={1} />
        <ToneText color={color} bold wrap="wrap">{clean(retirement.provider)} · queue {retirement.queueDepth ?? 0} · last {clean(operation(retirement))}</ToneText>
        <Box height={1} />
        <ToneText color={color} value="failed" wrap="wrap">queued/reserved work is cancelled, armed work becomes ambiguous, accepted work becomes unconfirmed — cannot be undone.</ToneText>
        <Box height={1} />
        <Box><ToneText color={color} value="failed" bold>y confirm</ToneText><ToneText color={color}> · </ToneText><ToneText color={color} bold>[N] cancel</ToneText></Box>
      </> : <>
        <ToneText color={color} dim>Delivery token</ToneText>
        <ToneText color={color} bold>{clean(model.token || "dlv_…")}</ToneText>
        <ToneText color={color} dim>{tokenFeedback(model.token)}</ToneText>
        <Box height={1} />
        <ToneText color={color} bold>Enter look up · Esc cancel</ToneText>
      </>}
  </Box>;
}

export { modalFits } from "./tui-model.js";

function Dialog({ model, columns, rows, color }: { model: Readonly<TuiModel>; columns: number; rows: number; color: boolean }) {
  if (!modalFits(model, columns, rows)) return <TooSmall mode={model.mode} color={color} />;
  return <Box width={columns} height={rows} alignItems="center" justifyContent="center">
    <DialogContent model={model} columns={columns} color={color} />
  </Box>;
}

function TooSmall({ mode, color }: { mode: TuiModel["mode"]; color: boolean }) {
  return <Box flexDirection="column" width="100%">
    <Box height={1} flexShrink={0}><ToneText color={color} bold wrap="truncate-end">Embassy · terminal too small</ToneText></Box>
    <Box height={1} flexShrink={0}><ToneText color={color} dim wrap="truncate-end">{mode === "confirm" ? "Resize to show the exact endpoint ID and consequences." : "Resize: needs 48×10."}</ToneText></Box>
    <Box height={1} flexShrink={0}><ToneText color={color} wrap="truncate-end">{mode === "confirm" ? "N cancel" : mode === "token" ? "Esc cancel" : "q quit"}</ToneText></Box>
  </Box>;
}

export function TuiView({ model, columns, rows, now, color }: TuiViewProps) {
  const width = Math.max(1, columns), height = Math.max(1, rows);
  if (height < 10 || width < 48) return <Box width={width} height={height} overflow="hidden"><TooSmall mode={model.mode} color={color} /></Box>;
  if (model.mode !== "browse") return <Dialog model={model} columns={width} rows={height} color={color} />;
  const all = content(model, color, now, width), source = sectionRows(model, width), selected = selectedIndex(model, source);
  const headerRows = 3 + (model.hosts && model.hosts.length > 1 ? 1 : 0) + (model.error ? 2 + (model.errorDetail ? 1 : 0) : model.snapshot?.safeErrorCode ? 1 : 0)
    + (model.restarted ? 1 : 0);
  const actionRows = model.action ? 1 : 0, available = Math.max(1, height - headerRows - actionRows - 3 - Number(model.section === "endpoints"));
  const focus = all.findIndex((entry) => entry.index === selected);
  const visible = viewport(all, focus, available), sizes = endpointWidths(width);
  const counter = `${model.section}${model.section === "result" ? " line" : ""} ${source.length ? `${selected < 0 ? "-" : selected + 1}/${source.length}` : "0/0"}`;
  const empty = model.error ? `Broker unreachable (!${model.error}).` : !model.snapshot ? "Broker not reachable."
    : model.section === "endpoints" ? "No endpoints registered." : model.section === "deliveries" ? "No deliveries yet."
      : model.section === "retirements" ? "No retirements." : "No result yet. Run an action to see its result here.";
  return <Box width={width} height={height} flexDirection="column">
    <Header model={model} width={width} now={now} color={color} />
    <SectionTabs model={model} color={color} />
    {model.section === "endpoints" ? <DataLine selected={false} color={color} width={width} cells={[
      { value: "State", width: 12, dim: true }, { value: "Endpoint", width: sizes.alias, dim: true },
      { value: "Type", width: 7, dim: true }, { value: "Queue", width: 6, right: true, dim: true },
      { value: "Outcome", width: sizes.outcome, dim: true },
    ]} /> : null}
    <Box flexDirection="column" height={available} flexShrink={0} overflow="hidden">
      {visible.above > 0 ? <ToneText color={color} dim>↑ {visible.above} more</ToneText> : null}
      {visible.entries.length ? visible.entries.map((entry) => <React.Fragment key={entry.key}>{entry.node}</React.Fragment>)
        : <ToneText color={color} dim>{empty}</ToneText>}
      <Box flexGrow={1} />
      {visible.below > 0 ? <ToneText color={color} dim>↓ {visible.below} more</ToneText> : null}
    </Box>
    {model.action ? <ToneText color={color} {...(model.actionRunning ? { value: "busy" } : {})} wrap="truncate-end">
      {clean(model.action)}{model.actionRunning ? " — polling paused" : ""}
    </ToneText> : null}
    <Rule width={width} color={color} />
    <Box height={1} flexShrink={0}><ToneText color={color} dim wrap="truncate-end">{counter} · [/]:host Tab:view ↑↓ r:refresh c:check d:token x:retire q:quit</ToneText></Box>
  </Box>;
}
