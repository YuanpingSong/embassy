import type {CSSProperties} from "react";
import {interpolate, useCurrentFrame, useVideoConfig} from "remotion";
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

export const TerminalWindow = ({captureId, title}: {captureId: CaptureId; title: string}) => {
  const currentFrame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const {capture, error} = useCapture(captureId);
  const timeMs = (currentFrame / fps) * 1000;
  const terminalFrame = capture ? frameAt(capture, timeMs) : undefined;
  const opacity = interpolate(currentFrame, [0, 8], [0, 1], {extrapolateRight: "clamp"});

  return (
    <div style={{...styles.shell, opacity}}>
      <div style={styles.chrome}>
        <div style={styles.lights}>
          {["#ff5f57", "#febc2e", "#28c840"].map((color) => (
            <i key={color} style={{...styles.light, backgroundColor: color}} />
          ))}
        </div>
        <div style={styles.title}>{title}</div>
      </div>
      <div style={styles.terminal}>
        {error ? (
          <div style={styles.missing}>
            <strong>REAL CAPTURE REQUIRED</strong>
            <span>{error}</span>
            <span>Place sanitized schema-v1 footage in demo/public/captures/.</span>
          </div>
        ) : terminalFrame ? <>
          {terminalFrame.rows.map((row, index) => (
            <div key={index} style={styles.line}>
              {row.map((run, runIndex) => <span key={runIndex} style={runStyle(run)}>{run.text}</span>)}
            </div>
          ))}
          {terminalFrame.cursor?.visible ? (
            <span
              aria-hidden
              style={{
                ...styles.cursor,
                left: `calc(24px + ${terminalFrame.cursor.column}ch)`,
                top: 12 + terminalFrame.cursor.row * 31.5,
              }}
            />
          ) : null}
        </> : null}
      </div>
    </div>
  );
};

const styles: Record<string, CSSProperties> = {
  shell: {
    height: 826,
    border: "1px solid #344052",
    borderRadius: 22,
    overflow: "hidden",
    boxShadow: "0 28px 90px rgba(0,0,0,.48)",
    background: "#0f131a",
  },
  chrome: {
    height: 42,
    display: "grid",
    gridTemplateColumns: "160px 1fr 160px",
    alignItems: "center",
    background: "#1a202b",
    borderBottom: "1px solid #303a4a",
  },
  lights: {display: "flex", gap: 10, paddingLeft: 20},
  light: {display: "block", width: 13, height: 13, borderRadius: "50%"},
  title: {gridColumn: 2, textAlign: "center", color: "#9ca8b9", fontSize: 22, fontWeight: 600},
  terminal: {
    height: 784,
    boxSizing: "border-box",
    padding: "12px 24px",
    overflow: "hidden",
    fontFamily: '"SFMono-Regular", Menlo, Monaco, Consolas, monospace',
    fontSize: 30,
    lineHeight: 1.05,
    whiteSpace: "pre",
    color: "#e8edf5",
    position: "relative",
  },
  line: {height: "1.05em"},
  cursor: {position: "absolute", width: "0.6em", height: "1.05em", background: "rgba(232,237,245,.72)"},
  missing: {display: "flex", flexDirection: "column", gap: 18, color: "#ff8793", whiteSpace: "normal"},
};
