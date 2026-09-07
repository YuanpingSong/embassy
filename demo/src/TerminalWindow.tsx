import type {CSSProperties} from "react";
import {useCurrentFrame, useVideoConfig} from "remotion";
import type {CaptureId, CellRun} from "./capture";
import {frameAt, useCapture} from "./capture";

const colors: Record<string, string> = {
  black: "#11151c", red: "#ff6b79", green: "#70d6a0", yellow: "#e9c46a",
  blue: "#75a7ff", magenta: "#d58cff", cyan: "#66d9ef", white: "#e8edf5",
  brightblack: "#7d8797", brightred: "#ff8793", brightgreen: "#94e2bd",
  brightyellow: "#f4d98a", brightblue: "#9bbdff", brightmagenta: "#e1a8ff",
  brightcyan: "#91e7f4", brightwhite: "#ffffff",
};

const resolveColor = (value: string | undefined, fallback: string): string => {
  if (!value || value.toLowerCase() === "default") return fallback;
  const named = colors[value.toLowerCase()];
  if (named) return named;
  return /^#?[0-9a-f]{6}$/iu.test(value) ? `#${value.replace(/^#/u, "")}` : fallback;
};

const runStyle = (run: CellRun): CSSProperties => {
  const foreground = resolveColor(run.fg, "#e8edf5");
  const background = resolveColor(run.bg, "transparent");
  return {
    color: run.inverse ? background === "transparent" ? "#10141b" : background : foreground,
    background: run.inverse ? foreground : background,
    fontWeight: run.bold ? 700 : 450,
    opacity: run.dim ? 0.62 : 1,
    textDecoration: run.underline ? "underline" : undefined,
  };
};

type TerminalWindowProps = Readonly<{
  captureId: string;
  title: string;
  width: number;
  height: number;
  fontSize?: number;
  lineHeight?: number;
  sourceStartMs?: number;
  sourceEndMs?: number;
  focusPattern?: string;
  viewportRow?: number;
  viewportRows?: number;
  cameraColumn?: number;
  viewportColumns?: number;
  highlightPattern?: string;
  accent?: string;
}>;

export const TerminalWindow = ({
  captureId,
  title,
  width,
  height,
  fontSize = 29,
  lineHeight = 1.04,
  sourceStartMs = 0,
  sourceEndMs = Infinity,
  focusPattern,
  viewportRow = 0,
  viewportRows,
  cameraColumn = 0,
  viewportColumns,
  highlightPattern,
  accent = "#f4a259",
}: TerminalWindowProps) => {
  const currentFrame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const {capture, error} = useCapture(captureId as CaptureId);
  const timeMs = Math.min(sourceEndMs, sourceStartMs + (currentFrame / fps) * 1000);
  const terminalFrame = capture ? frameAt(capture, timeMs) : undefined;
  const focusRow = focusPattern ? terminalFrame?.rows.findIndex(row => row.map(run => run.text).join("").includes(focusPattern)) : -1;
  const firstRow = focusRow !== undefined && focusRow >= 0 ? focusRow : viewportRow;
  const rows = terminalFrame?.rows.slice(firstRow, viewportRows ? firstRow + viewportRows : undefined);
  const rowHeight = fontSize * lineHeight;
  const cursor = terminalFrame?.cursor;
  const cursorRow = cursor ? cursor.row - firstRow : -1;
  const highlightedRow = rows?.findIndex((row) => row.map((run) => run.text).join("").includes(highlightPattern ?? "\u0000")) ?? -1;

  return (
    <div style={{...styles.shell, width, height}}>
      <div style={styles.chrome}>
        <div style={styles.lights}>
          {["#ff5f57", "#febc2e", "#28c840"].map((color) => (
            <i key={color} style={{...styles.light, backgroundColor: color}} />
          ))}
        </div>
        <div style={styles.title}>{title}</div>
      </div>
      <div style={{...styles.terminal, height: height - 42, fontSize, lineHeight}}>
        {error ? (
          <div style={styles.missing}>
            <strong>REAL CAPTURE REQUIRED</strong>
            <span>{error}</span>
            <span>Place sanitized schema-v1 footage in demo/public/captures/.</span>
          </div>
        ) : terminalFrame ? <div style={{
          ...styles.viewport,
          transform: `translateX(-${cameraColumn}ch)`,
          clipPath: viewportColumns === undefined ? undefined
            : `inset(0 calc(100% - ${cameraColumn + viewportColumns}ch) 0 ${cameraColumn}ch)`,
        }}>
          {rows?.map((row, index) => (
            <div
              key={index}
              style={{
                ...styles.line,
                height: `${lineHeight}em`,
                ...(highlightPattern && index === highlightedRow ? {minWidth: 0, width: viewportColumns ? `${viewportColumns}ch` : width - 38, background: `${accent}12`, boxShadow: `inset 0 0 0 2px ${accent}`} : {}),
              }}
            >
              {row.map((run, runIndex) => <span key={runIndex} style={runStyle(run)}>{run.text}</span>)}
            </div>
          ))}
          {cursor?.visible && cursorRow >= 0 && (!viewportRows || cursorRow < viewportRows) ? (
            <span
              aria-hidden
              style={{
                ...styles.cursor,
                left: `${cursor.column}ch`,
                top: cursorRow * rowHeight,
                height: rowHeight,
              }}
            />
          ) : null}
        </div> : null}
      </div>
    </div>
  );
};

const styles: Record<string, CSSProperties> = {
  shell: {
    border: "1px solid #393940",
    borderRadius: 18,
    overflow: "hidden",
    boxShadow: "0 28px 90px rgba(0,0,0,.48)",
    background: "#131316",
  },
  chrome: {
    height: 42,
    display: "grid",
    gridTemplateColumns: "100px 1fr 100px",
    alignItems: "center",
    background: "#1a1a1e",
    borderBottom: "1px solid #393940",
  },
  lights: {display: "flex", gap: 10, paddingLeft: 20},
  light: {display: "block", width: 13, height: 13, borderRadius: "50%"},
  title: {gridColumn: 2, textAlign: "center", color: "#8a8a96", fontSize: 28, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis"},
  terminal: {
    boxSizing: "border-box",
    padding: "12px 18px",
    overflow: "hidden",
    fontFamily: '"SFMono-Regular", Menlo, Monaco, Consolas, monospace',
    whiteSpace: "pre",
    color: "#e8edf5",
    position: "relative",
  },
  viewport: {position: "relative", width: "max-content", minWidth: "100%"},
  line: {minWidth: "100%"},
  cursor: {position: "absolute", width: "0.6em", background: "rgba(232,237,245,.72)"},
  missing: {display: "flex", flexDirection: "column", gap: 18, color: "#ff8793", whiteSpace: "normal"},
};
