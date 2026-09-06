import React from "react";
import { Box, Text } from "ink";
import {
  age, clean, collisionAliases, endpointGroup, endpointKey, endpointRows, groups, isLoopback,
  list, modalFits, object, operation, retirementLine, sectionRows, summaryLine, text, tokenFeedback,
  unsuccessful, type DeliverySummary, type EndpointRow, type Obj, type Section, type TuiModel,
} from "./tui-model.js";

export type TuiViewProps = Readonly<{ model: Readonly<TuiModel>; columns: number; rows: number; now: number; color: boolean }>;
type Tone = "plain" | "good" | "busy" | "waiting" | "dormant" | "bad";

function tone(value: string): Tone {
  if (["healthy", "idle", "ready", "delivered", "ok"].includes(value)) return "good";
  if (["busy", "working", "queued", "reserved", "armed", "accepted"].includes(value)) return "busy";
  if (value === "waiting") return "waiting";
  if (["dormant", "cached"].includes(value)) return "dormant";
  if (unsuccessful.has(value) || ["stale", "unreachable", "not reachable", "degraded", "systemError"].includes(value)) return "bad";
  return "plain";
}

function ToneText({ children, value, color, bold = false, inverse = false, dim = false, wrap }:
  React.PropsWithChildren<{ value?: string; color: boolean; bold?: boolean; inverse?: boolean; dim?: boolean; wrap?: "truncate-end" | "wrap" }>) {
  const semantic = tone(value ?? "");
  const foreground = !color ? undefined : semantic === "good" ? "green" : semantic === "busy" ? "yellow"
    : semantic === "waiting" ? "magenta" : semantic === "bad" ? "red" : undefined;
  return <Text {...(foreground ? { color: foreground } : {})} bold={color && bold} inverse={color && inverse}
    dimColor={color && (dim || semantic === "dormant")} {...(wrap ? { wrap } : {})}>{children}</Text>;
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
    <ToneText color={color} value={host.state} bold inverse={host.selected} wrap="truncate-end">
      {host.selected ? `[${clean(host.host)} · ${clean(host.state)}]` : `${clean(host.host)} · ${clean(host.state)}`}
    </ToneText>
  </Box>)}</Box>;
}

function Header({ model, width, now, color }: { model: Readonly<TuiModel>; width: number; now: number; color: boolean }) {
  const snapshot = model.snapshot;
  const health = model.error ? "UNREACHABLE" : snapshot ? text(snapshot.health, "unknown") : "not reachable";
  const elapsed = model.snapshotAt === undefined ? "never" : `${age(now - model.snapshotAt)} ago`;
  return <Box flexDirection="column" flexShrink={0}>
    <HostTabs model={model} color={color} width={width} />
    <Box height={1}>
      <Box width={Math.max(12, width - 43)}><ToneText color={color} bold wrap="truncate-end">Embassy {clean(model.host ?? "local")}</ToneText></Box>
      <Box width={25}><ToneText color={color} value={health.toLowerCase()} inverse={!!model.error}>broker {clean(health)}</ToneText></Box>
      <Box width={18}><ToneText color={color} dim wrap="truncate-end">ledger rev {String(snapshot?.revision ?? "-")}</ToneText></Box>
    </Box>
    <ToneText color={color} dim>Updated {elapsed} · not a provider readiness proof</ToneText>
    {model.error ? <>
      <ToneText color={color} value="stale">STALE {age(now - (model.staleSince ?? now))} !{clean(model.error)}</ToneText>
      <ToneText color={color} dim>{snapshot ? `Last-known: ${clean(text(snapshot.health))}. ` : ""}Run embassy service status on {clean(model.host ?? "local")}.</ToneText>
      {model.errorDetail ? <ToneText color={color} value="failed">{clean(model.errorDetail)}</ToneText> : null}
    </> : snapshot?.safeErrorCode ? <ToneText color={color} value="failed">!{clean(text(snapshot.safeErrorCode))}</ToneText> : null}
    {model.restarted ? <ToneText color={color} value="busy">Ledger revision decreased; broker restarted/reset.</ToneText> : null}
    {object(snapshot?.codex) ? <ToneText color={color} dim>
      Codex discovery {snapshot.codex.complete ? "up to 20 most recent" : "partial"}
      {snapshot.codex.truncated ? " · truncated" : ""} · {observationAge(snapshot.codex.observedAt, now)}
      {snapshot.codex.safeErrorCode ? ` !${clean(text(snapshot.codex.safeErrorCode))}` : ""}
    </ToneText> : null}
    <Rule width={width} color={color} />
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
    const label = `${index + 1} ${section}${section === "deliveries" && failed ? ` (${failed} failed)` : ""}`;
    return <Box key={section} marginRight={2}><ToneText color={color} inverse={selected} bold={selected} dim={!selected}>
      {selected ? `[${label}]` : label}
    </ToneText></Box>;
  })}</Box>;
}

function Selected({ selected, color, children }: React.PropsWithChildren<{ selected: boolean; color: boolean }>) {
  return <ToneText color={color} inverse={selected}>{selected ? "> " : "  "}{children}</ToneText>;
}

function EndpointLine({ row, selected, collisions, color, now }: { row: EndpointRow; selected: boolean; collisions: Set<string>; color: boolean; now: number }) {
  const state = row.local ? text(row.codex?.state, "unknown") : row.safeErrorCode ? "stale" : "cached";
  const alias = clean(row.alias), collision = collisions.has(row.alias);
  return <Box flexDirection="column">
    <Box height={1} flexShrink={0}>
      <Box width={14} flexShrink={0}><Selected selected={selected} color={color}><ToneText color={color} value={state} wrap="truncate-end">{clean(state)}</ToneText></Selected></Box>
      <Box flexGrow={1} flexBasis={0} minWidth={0} marginRight={1}><ToneText color={color} bold inverse={selected} wrap="truncate-end">{alias}</ToneText></Box>
      <Box width={7} flexShrink={0}><ToneText color={color} dim inverse={selected} wrap="truncate-end">{clean(row.provider)}</ToneText></Box>
      <Box width={8} flexShrink={0} justifyContent="flex-end"><ToneText color={color} dim inverse={selected}>
        queue {row.local ? String(row.queueDepth ?? 0) : "—"}
      </ToneText></Box>
      <Box width={20} flexShrink={0} marginLeft={1}><ToneText color={color} {...(row.local && row.lastOperation ? { value: text(row.lastOperation.outcome) } : { dim: true })} inverse={selected} wrap="truncate-end">
        {row.local ? `last ${clean(operation(row))}` : "last not reported"}
      </ToneText></Box>
    </Box>
    {collision ? <Box paddingLeft={14} height={1}><ToneText color={color} dim wrap="truncate-end">ambiguous name · endpoint …{clean(row.id.slice(-8))}</ToneText></Box> : null}
    {!row.local ? <Box paddingLeft={12}><ToneText color={color} value={row.safeErrorCode ? "stale" : "dormant"} dim wrap="truncate-end">
      SSH {clean(row.host)} · catalog {observationAge(row.observedAt, now)}
      {row.safeErrorCode ? ` !${clean(row.safeErrorCode)}` : ""} · queue/last not reported
    </ToneText></Box> : null}
  </Box>;
}

function DeliveryLine({ row, selected, color }: { row: Obj | DeliverySummary; selected: boolean; color: boolean }) {
  if ((row as DeliverySummary).summary === true)
    return <Selected selected={selected} color={color}>{clean(summaryLine(row as DeliverySummary))}</Selected>;
  const item = row as Obj;
  const state = text(item.state), fault = unsuccessful.has(state) && item.safeErrorCode ? ` !${clean(text(item.safeErrorCode))}` : "";
  const source = clean(text(item.source, "unavailable sender")), target = clean(text(item.target, "unavailable recipient"));
  return <Box flexDirection="column" flexShrink={0}>
    <Box height={1} flexShrink={0}>
    <Box width={11} flexShrink={0} justifyContent="flex-end"><Selected selected={selected} color={color}>{age(item.ageMs)} ago </Selected></Box>
    <Box width={13} flexShrink={0}><ToneText color={color} value={state} inverse={selected}>{clean(state)}</ToneText></Box>
    <Box flexGrow={1} flexBasis={0} minWidth={0}><ToneText color={color} bold inverse={selected} wrap="truncate-end">
      {source} -&gt; {target}{isLoopback(source) || isLoopback(target) ? " (loopback check)" : ""}
    </ToneText></Box>
    </Box>
    {fault ? <Box paddingLeft={24} height={1}><ToneText color={color} value="failed" inverse={selected} wrap="truncate-end">{fault.trim()}</ToneText></Box> : null}
  </Box>;
}

type Entry = Readonly<{ key: string; index?: number; node: React.ReactNode }>;
function content(model: Readonly<TuiModel>, color: boolean, now: number, width: number): Entry[] {
  const rows = sectionRows(model, width), selected = selectedIndex(model, rows), collisions = collisionAliases(model.snapshot);
  const entries: Entry[] = [];
  if (model.section === "endpoints") {
    let prior = -1;
    for (const [index, item] of (rows as EndpointRow[]).entries()) {
      const group = endpointGroup(item);
      if (group !== prior) {
        const count = (rows as EndpointRow[]).filter((row) => endpointGroup(row) === group).length;
        entries.push({ key: `group-${group}`, node: <ToneText color={color} bold>{groups[group]} ({count})</ToneText> });
        prior = group;
      }
      entries.push({ key: `${endpointKey(item)}\0${index}`, index,
        node: <EndpointLine row={item} selected={index === selected} collisions={collisions} color={color} now={now} /> });
    }
  } else if (model.section === "deliveries") {
    rows.forEach((row, index) => entries.push({ key: `delivery-${index}`, index,
      node: <DeliveryLine row={row as Obj | DeliverySummary} selected={index === selected} color={color} /> }));
  } else if (model.section === "retirements") {
    rows.forEach((row, index) => entries.push({ key: `retirement-${index}`, index,
      node: <Selected selected={index === selected} color={color}><ToneText color={color} bold>{clean(retirementLine(row as Obj, now))}</ToneText></Selected> }));
  } else if (model.result) {
    rows.forEach((row, index) => {
      const state = /"(?:state|status|health|outcome)":\s*"([a-zA-Z]+)"/.exec(String(row))?.[1];
      entries.push({ key: `result-${index}`, index,
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

function DialogContent({ model, columns, color }: { model: Readonly<TuiModel>; columns: number; color: boolean }) {
  const retirement = model.mode === "confirm" ? model.retiring : undefined;
  return <Box width={Math.min(78, columns - 4)} borderStyle="round" borderColor={color ? "gray" : undefined}
      paddingX={2} paddingY={1} flexDirection="column">
      <ToneText color={color} bold>{retirement ? "Retire endpoint" : "Look up delivery"}</ToneText>
      <Box height={1} />
      {retirement ? <>
        <ToneText color={color} bold>Host: {clean(retirement.host)}</ToneText>
        <ToneText color={color} bold>Alias: {clean(retirement.alias)}</ToneText>
        <ToneText color={color} dim>Endpoint ID</ToneText>
        <ToneText color={color} bold wrap="wrap">{clean(retirement.id)}</ToneText>
        <Box height={1} />
        <ToneText color={color}>{clean(retirement.provider)} · queue {retirement.queueDepth ?? 0} · last {clean(operation(retirement))}</ToneText>
        <Box height={1} />
        <ToneText color={color} wrap="wrap">queued/reserved work is cancelled, armed work becomes ambiguous, accepted work becomes unconfirmed — cannot be undone.</ToneText>
        <Box height={1} />
        <ToneText color={color} bold>y confirm · [N] cancel</ToneText>
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
    <Box height={1} flexShrink={0}><ToneText color={color} dim wrap="truncate-end">{mode === "confirm" ? "Resize to show the exact endpoint ID and consequences." : "Resize for the full interface."}</ToneText></Box>
    <Box height={1} flexShrink={0}><ToneText color={color} wrap="truncate-end">{mode === "confirm" ? "N cancel" : mode === "token" ? "Esc cancel" : "q quit"}</ToneText></Box>
  </Box>;
}

export function TuiView({ model, columns, rows, now, color }: TuiViewProps) {
  const width = Math.max(1, columns), height = Math.max(1, rows);
  if (height < 10 || width < 48) return <Box width={width} height={height} overflow="hidden"><TooSmall mode={model.mode} color={color} /></Box>;
  if (model.mode !== "browse") return <Dialog model={model} columns={width} rows={height} color={color} />;
  const all = content(model, color, now, width), source = sectionRows(model, width), selected = selectedIndex(model, source);
  const headerRows = 7 + (model.hosts && model.hosts.length > 1 ? 1 : 0) + (model.error ? 2 + (model.errorDetail ? 1 : 0) : model.snapshot?.safeErrorCode ? 1 : 0)
    + (model.restarted ? 1 : 0) + (object(model.snapshot?.codex) ? 1 : 0);
  const actionRows = model.action ? 1 : 0, available = Math.max(1, height - headerRows - actionRows - 3);
  const focus = all.findIndex((entry) => entry.index === selected);
  const start = Math.max(0, Math.min(focus - Math.floor(available / 2), Math.max(0, all.length - available)));
  const visible = all.slice(start, start + available);
  return <Box width={width} height={height} flexDirection="column">
    <Header model={model} width={width} now={now} color={color} />
    <SectionTabs model={model} color={color} />
    <Box flexDirection="column" flexGrow={1} overflow="hidden">
      {visible.length ? visible.map((entry) => <React.Fragment key={entry.key}>{entry.node}</React.Fragment>)
        : <ToneText color={color} dim>No rows.</ToneText>}
    </Box>
    <ToneText color={color} dim>{model.section} {source.length ? `${selected < 0 ? "-" : selected + 1}/${source.length}` : "0/0"}</ToneText>
    {model.action ? <ToneText color={color} {...(model.actionRunning ? { value: "busy" } : {})} wrap="truncate-end">
      {clean(model.action)}{model.actionRunning ? " — polling paused" : ""}
    </ToneText> : null}
    <Rule width={width} color={color} />
    <Box height={1} flexShrink={0}><ToneText color={color} dim wrap="truncate-end">[]host Tab:view ↑↓:select r:refresh c:check d:token x:retire q:quit</ToneText></Box>
  </Box>;
}
