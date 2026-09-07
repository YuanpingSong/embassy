import type {CSSProperties} from "react";
import {AbsoluteFill, Easing, interpolate, Sequence, useCurrentFrame} from "remotion";
import type {CaptureId} from "./capture";
import {TerminalWindow} from "./TerminalWindow";

type Scene = Readonly<{
  from: number;
  duration: number;
  capture: CaptureId;
  eyebrow: string;
  caption: string;
  terminalTitle: string;
}>;

const scenes: readonly Scene[] = [
  {from: 0, duration: 270, capture: "tui-overview", eyebrow: "ONE VIEW", caption: "Claude sessions and Codex agents, side by side", terminalTitle: "m5dev — embassy tui"},
  {from: 270, duration: 330, capture: "claude-send", eyebrow: "SEND BY NAME", caption: "Claude asks a Codex agent for a review", terminalTitle: "Claude Code — m5dev"},
  {from: 600, duration: 360, capture: "codex-wake", eyebrow: "NATIVE WAKE", caption: "The Codex task wakes with exact provenance", terminalTitle: "Codex CLI — codex-reviewer@m5dev"},
  {from: 960, duration: 270, capture: "claude-reply", eyebrow: "IDENTITY-BOUND REPLY", caption: "The answer returns to Claude natively", terminalTitle: "Claude Code — m5dev"},
  {from: 1230, duration: 270, capture: "tui-settled", eyebrow: "TRUTHFUL RECEIPTS", caption: "Both deliveries settle in the ledger", terminalTitle: "m5dev — embassy tui"},
];

const SceneView = ({scene}: {scene: Scene}) => {
  const frame = useCurrentFrame();
  const enter = interpolate(frame, [0, 14], [0, 1], {easing: Easing.out(Easing.cubic), extrapolateRight: "clamp"});
  const exit = interpolate(frame, [scene.duration - 14, scene.duration], [1, 0], {easing: Easing.in(Easing.cubic), extrapolateLeft: "clamp"});
  const opacity = Math.min(enter, exit);
  return (
    <AbsoluteFill style={{...styles.scene, opacity}}>
      <header style={{transform: `translateY(${(1 - enter) * 22}px)`}}>
        <div style={styles.eyebrow}>{scene.eyebrow}</div>
        <div style={styles.caption}>{scene.caption}</div>
      </header>
      <TerminalWindow captureId={scene.capture} title={scene.terminalTitle} />
    </AbsoluteFill>
  );
};

const EndCard = () => {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [0, 18], [0, 1], {extrapolateRight: "clamp"});
  return (
    <AbsoluteFill style={{...styles.end, opacity}}>
      <div style={styles.mark}>E</div>
      <h1>Embassy</h1>
      <p>Claude Code ↔ Codex CLI</p>
      <p style={styles.tagline}>by name, on your machines.</p>
    </AbsoluteFill>
  );
};

export const EmbassyDemo = () => (
  <AbsoluteFill style={styles.canvas}>
    <div style={styles.glow} />
    {scenes.map((scene) => (
      <Sequence key={scene.capture} from={scene.from} durationInFrames={scene.duration} premountFor={30}>
        <SceneView scene={scene} />
      </Sequence>
    ))}
    <Sequence from={1500} durationInFrames={150}><EndCard /></Sequence>
  </AbsoluteFill>
);

const teaserScenes: readonly Scene[] = [
  {...scenes[0]!, from: 0, duration: 120, caption: "Every Claude and Codex agent, in one view"},
  {...scenes[2]!, from: 120, duration: 120, caption: "Send by name. Wake the agent natively."},
];

export const EmbassyTeaser = () => (
  <AbsoluteFill style={styles.canvas}>
    <div style={styles.glow} />
    {teaserScenes.map((scene) => (
      <Sequence key={scene.capture} from={scene.from} durationInFrames={scene.duration} premountFor={20}>
        <SceneView scene={scene} />
      </Sequence>
    ))}
    <Sequence from={240} durationInFrames={120}><EndCard /></Sequence>
  </AbsoluteFill>
);

const styles: Record<string, CSSProperties> = {
  canvas: {background: "#090d13", color: "#f6f8fb", fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif"},
  glow: {position: "absolute", inset: 0, background: "radial-gradient(circle at 50% 15%, #163352 0%, transparent 54%)", opacity: 0.7},
  scene: {padding: "48px 96px", boxSizing: "border-box", display: "grid", gridTemplateRows: "120px 826px", gap: 26},
  eyebrow: {fontSize: 24, letterSpacing: "0.18em", color: "#66d9ef", fontWeight: 750, marginBottom: 18},
  caption: {fontSize: 48, lineHeight: 1.08, letterSpacing: "-0.025em", fontWeight: 760},
  end: {alignItems: "center", justifyContent: "center", textAlign: "center", background: "radial-gradient(circle at center, #173756, #090d13 58%)"},
  mark: {width: 110, height: 110, borderRadius: 28, display: "grid", placeItems: "center", background: "#66d9ef", color: "#081019", fontSize: 62, fontWeight: 900, marginBottom: 34},
  tagline: {color: "#9ca8b9", marginTop: 10},
};
