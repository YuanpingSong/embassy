import { PassThrough, type Readable, type Writable } from "node:stream";
import { createElement } from "react";
import { render, renderToString, useInput, type Instance } from "ink";
import type { BrokerCommand } from "./broker-control.js";
import { TuiView, modalFits } from "./tui-view.js";
import { type TuiModel, type Obj, type Section, type EndpointRow, object, text, clean, errorText, json, endpointRows, endpointKey, sectionRows, deliveryToken } from "./tui-model.js";
export type { TuiModel } from "./tui-model.js";

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
  terminal?: Readonly<{ noColor?: boolean; dumb?: boolean }>;
}>;

export function renderTui(model: Readonly<TuiModel>, columns = 80, rows = 24, now = Date.now(), color = false): string {
  return renderToString(createElement(TuiView, { model, columns, rows, now, color }), { columns });
}

/** Interactive, dependency-free client over the existing broker commands. */
export async function runTui(dependencies: TuiDependencies): Promise<void> {
  const { input, output, call, renderStatus, signal } = dependencies;
  if (!output.isTTY || !input.isTTY || (dependencies.terminal?.dumb ?? process.env.TERM === "dumb")) {
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
  const color = !(dependencies.terminal?.noColor ?? process.env.NO_COLOR !== undefined);
  let closed = false, ink: Instance | undefined;
  let drawTimer: ReturnType<typeof setTimeout> | undefined;
  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => { resolveDone = resolve; });
  const keyInput = Object.assign(new PassThrough(), {
    isTTY: true, setRawMode: () => keyInput, ref: () => keyInput, unref: () => keyInput,
  });
  const screen = () => {
    useInput((value, key) => {
      const name = key.ctrl ? value : key.upArrow ? "up" : key.downArrow ? "down" : key.escape ? "escape"
        : key.return ? "return" : key.tab ? "tab" : key.backspace || key.delete ? "backspace" : undefined;
      if (!name && !key.ctrl && value.length > 1) {
        for (const character of value) {
          if (character === "\r" || character === "\n") onKeypress("", { name: "return" });
          else onKeypress(character);
        }
      } else onKeypress(value, { ...(name ? { name } : {}), ctrl: key.ctrl, shift: key.shift });
    });
    return createElement(TuiView, { model, columns: output.columns || 80,
      rows: Math.max(1, (output.rows || 24) - 1), now: Date.now(), color });
  };
  const draw = () => {
    if (closed) return;
    model.hosts = panes.map((pane, index) => ({ host: pane.model.host!, selected: index === active,
      state: pane.model.error ? "stale" : pane.model.snapshot ? text(pane.model.snapshot.health) : "connecting" }));
    if (ink) ink.rerender(createElement(screen));
    else ink = render(createElement(screen), { stdout: output as NodeJS.WriteStream,
      stdin: keyInput as unknown as NodeJS.ReadStream, stderr: output as NodeJS.WriteStream,
      patchConsole: false, exitOnCtrlC: false, incrementalRendering: true, interactive: true, maxFps: 30 });
    void ink.waitUntilRenderFlush().catch(finish);
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
    ink?.unmount(); ink?.cleanup();
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
    output.write(`${color ? "\x1b[0m" : ""}\x1b[?25h\x1b[?1049l`); resolveDone(); };
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
      const visible = retiring ? modalFits({ ...model, mode: "confirm", retiring }, output.columns || 80, (output.rows || 24) - 1) : false;
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
  input.on("data", onInputData); input.on("end", finish); input.on("error", finish);
  output.on?.("resize", draw); signal?.addEventListener("abort", finish, { once: true });
  if (!signal) { process.on("SIGINT", finish); process.on("SIGTERM", finish); }
  try { if (!priorRaw) input.setRawMode?.(true); } catch (error) { finish(); throw error; }
  output.write("\x1b[?1049h\x1b[?25l"); draw(); scheduleDraw();
  for (const pane of panes) void snapshot(pane).then(() => schedulePoll(pane));
  await done;
}
