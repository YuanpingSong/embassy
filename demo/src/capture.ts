import {continueRender, delayRender, staticFile} from "remotion";
import {useEffect, useState} from "react";

export const captureIds = [
  "tui-overview",
  "claude-send",
  "codex-wake",
  "claude-reply",
  "tui-settled",
] as const;

export type CaptureId = (typeof captureIds)[number];

export type CellRun = Readonly<{
  text: string;
  // The recorder emits ANSI names, default colors, or six-digit RGB values.
  fg?: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
  inverse?: boolean;
  underline?: boolean;
}>;

export type CaptureFrame = Readonly<{
  timeMs: number;
  rows: readonly (readonly CellRun[])[];
  cursor?: Readonly<{row: number; column: number; visible: boolean}>;
}>;

export type TerminalCapture = Readonly<{
  version: 1;
  columns: number;
  rows: number;
  frames: readonly CaptureFrame[];
}>;

const isFiniteInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && Number.isFinite(value);

const parseCapture = (value: unknown): TerminalCapture => {
  if (!value || typeof value !== "object") throw new Error("capture must be an object");
  const candidate = value as Record<string, unknown>;
  if (candidate.version !== 1 || !isFiniteInteger(candidate.columns) || !isFiniteInteger(candidate.rows)) {
    throw new Error("capture must use schema version 1 with integer columns and rows");
  }
  if (candidate.columns < 1 || candidate.rows < 1 || !Array.isArray(candidate.frames)) {
    throw new Error("capture dimensions and frames are invalid");
  }
  let previous = -1;
  for (const frame of candidate.frames) {
    if (!frame || typeof frame !== "object") throw new Error("capture frame must be an object");
    const entry = frame as Record<string, unknown>;
    if (typeof entry.timeMs !== "number" || entry.timeMs < previous || !Array.isArray(entry.rows)) {
      throw new Error("capture frame timestamps must be monotonic and rows must be arrays");
    }
    previous = entry.timeMs;
    for (const row of entry.rows) {
      if (!Array.isArray(row) || row.some((run) => !run || typeof run !== "object" || typeof run.text !== "string")) {
        throw new Error("capture rows must contain text runs");
      }
    }
  }
  return candidate as unknown as TerminalCapture;
};

export const useCapture = (id: CaptureId) => {
  const [state, setState] = useState<
    {capture?: TerminalCapture; error?: string; handle: number}
  >(() => ({handle: delayRender(`Loading terminal capture ${id}`)}));

  useEffect(() => {
    let live = true;
    fetch(staticFile(`captures/${id}.json`))
      .then(async (response) => {
        if (!response.ok) throw new Error(`capture ${id}.json is missing (${response.status})`);
        return parseCapture(await response.json());
      })
      .then((capture) => {
        if (live) setState((old) => ({...old, capture}));
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        if (live) setState((old) => ({...old, error: message}));
      })
      .finally(() => continueRender(state.handle));
    return () => {
      live = false;
    };
  }, [id, state.handle]);

  return state;
};

export const frameAt = (capture: TerminalCapture, timeMs: number): CaptureFrame => {
  let chosen = capture.frames[0];
  if (!chosen) return {timeMs: 0, rows: []};
  for (const frame of capture.frames) {
    if (frame.timeMs > timeMs) break;
    chosen = frame;
  }
  return chosen;
};
