import type {CSSProperties, ReactNode} from "react";
import {AbsoluteFill, Easing, Img, interpolate, Sequence, staticFile, useCurrentFrame} from "remotion";
import {TerminalWindow} from "./TerminalWindow";

const AMBER = "#f4a259";
const TERRACOTTA = "#c96442";
const INK = "#131316";
const PANEL = "#1a1a1e";
const TEXT = "#eef1f5";
const MUTED = "#8a8a96";

const Brand = () => (
  <div style={styles.brand}>
    <Img src={staticFile("mark.svg")} style={{width: 42, height: 42}} />
    <span>Embassy</span>
  </div>
);

const Caption = ({title, children}: {title?: string; children: ReactNode}) => (
  <header style={styles.captionArea}>
    {title ? <div style={styles.eyebrow}>{title}</div> : null}
    <div style={styles.caption}>{children}</div>
  </header>
);

const BrokerLane = ({reverse = false, complete = false, token, entering}: {reverse?: boolean; complete?: boolean; token: string; entering: boolean}) => {
  const frame = useCurrentFrame();
  const progress = interpolate(frame, [18, 86], [0, 1], {
    easing: Easing.inOut(Easing.cubic),
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  return (
    <div style={styles.brokerColumn}>
      <div style={styles.brokerWord}>EMBASSY</div>
      <div style={styles.brokerNode}><Img src={staticFile("mark.svg")} style={{width: 52, height: 52}} /></div>
      <div style={styles.direction}>{reverse ? "←" : "→"}</div>
      <div style={{...styles.envelope, transform: `translateX(${(reverse ? -1 : 1) * (entering ? progress - 1 : progress) * 78}px)`}}>✉</div>
      <div style={{...styles.receipt, opacity: complete ? interpolate(frame, [86, 100], [0, 1], {extrapolateRight: "clamp"}) : 0}}>✓</div>
      <div style={{...styles.tokenFlash, opacity: interpolate(frame, [72, 88, 126, 140], [0, 1, 1, 0], {extrapolateLeft: "clamp", extrapolateRight: "clamp"})}}>{token}</div>
    </div>
  );
};

const Scene = ({duration, children, fadeOut = true}: {duration: number; children: ReactNode; fadeOut?: boolean}) => {
  const frame = useCurrentFrame();
  const opacity = fadeOut ? interpolate(frame, [duration - 8, duration], [1, 0], {extrapolateLeft: "clamp"}) : 1;
  return <AbsoluteFill style={{...styles.scene, opacity}}>{children}<Brand /></AbsoluteFill>;
};

const AgentsOverview = () => (
  <Scene duration={180}>
    <Caption title="Every agent, one view">Claude sessions and Codex agents. Embassy sees both, by name.</Caption>
    <div style={styles.overviewGrid}>
      <div style={styles.sidePane}>
        <TerminalWindow captureId="v2-claude-agents" title="claude agents" width={430} height={760} fontSize={28} lineHeight={1.02} viewportRow={9} viewportRows={3} />
      </div>
      <div style={styles.centerPane}>
        <div style={styles.brokerLane}><span>Claude</span><b>→</b><Img src={staticFile("mark.svg")} style={{width: 44, height: 44}} /><b>→</b><span>Codex</span></div>
        <TerminalWindow captureId="v2-tui-overview" title="m5dev — embassy tui" width={850} height={760} fontSize={28} lineHeight={1.02} viewportRow={5} viewportRows={23} viewportColumns={47} accent={AMBER} />
      </div>
      <div style={styles.sidePane}>
        <TerminalWindow captureId="v2-codex-agents" title="codex agents" width={430} height={760} fontSize={28} lineHeight={1.02} viewportRow={18} viewportRows={2} cameraColumn={4} viewportColumns={20} />
      </div>
    </div>
  </Scene>
);

type ActionSceneProps = Readonly<{
  duration: number;
  caption: string;
  captureId: string;
  title: string;
  sourceStartMs?: number;
  cameraFrom?: number;
  cameraTo?: number;
  reverse?: boolean;
  complete?: boolean;
  active: "claude" | "codex";
  token: string;
  highlightPattern?: string;
}>;

const ActionScene = ({duration, caption, captureId, title, sourceStartMs, cameraFrom = 0, cameraTo = 8, reverse, complete, active, token, highlightPattern}: ActionSceneProps) => {
  const frame = useCurrentFrame();
  const cameraColumn = interpolate(frame, [0, Math.max(1, duration - 1)], [cameraFrom, cameraTo], {
    easing: Easing.inOut(Easing.cubic),
    extrapolateRight: "clamp",
  });
  return (
    <Scene duration={duration}>
      <Caption>{caption}</Caption>
      <div style={{...styles.actionGrid, gridTemplateColumns: active === "claude" ? "1100px 160px 500px" : "500px 160px 1100px"}}>
        {reverse && active === "claude" ? <>
          <span style={{...styles.laneTick, left: 1060, opacity: frame >= 86 ? 1 : 0}}>✓</span>
          <span style={{...styles.laneTick, right: 20, opacity: frame >= 86 ? 1 : 0}}>✓</span>
        </> : null}
        {active === "claude" ? (
          <TerminalWindow captureId={captureId} title={title} width={1100} height={824} fontSize={29} sourceStartMs={sourceStartMs} cameraColumn={cameraColumn} highlightPattern={highlightPattern} accent={highlightPattern ? TERRACOTTA : AMBER} />
        ) : (
          <TerminalWindow captureId="claude-send" title="Claude · demo" width={500} height={824} fontSize={28} sourceStartMs={6000} viewportRow={3} viewportRows={14} />
        )}
        <BrokerLane reverse={reverse} complete={complete} token={token} entering={reverse ? active === "codex" : active === "claude"} />
        {active === "codex" ? (
          <TerminalWindow captureId={captureId} title={title} width={1100} height={824} fontSize={29} sourceStartMs={sourceStartMs} cameraColumn={cameraColumn} highlightPattern={highlightPattern} accent={highlightPattern ? TERRACOTTA : AMBER} />
        ) : (
          <TerminalWindow captureId={reverse ? "codex-wake" : "v2-codex-idle"} title="Codex · reviewer" width={500} height={824} fontSize={28} sourceStartMs={reverse ? 11000 : 0} viewportRow={reverse ? 13 : 0} viewportRows={5} />
        )}
      </div>
    </Scene>
  );
};

const FullTuiScene = ({duration, captureId, caption, ssh = false}: {duration: number; captureId: string; caption: string; ssh?: boolean}) => (
  <Scene duration={duration} fadeOut={ssh}>
    <Caption>{caption}</Caption>
    <div style={styles.fullTui}>
      <TerminalWindow captureId={captureId} title="m5dev — embassy tui" width={1776} height={824} fontSize={29} cameraColumn={0} accent={AMBER} />
      {ssh ? (
        <svg style={styles.hostLink} width="260" height="28" viewBox="0 0 260 28"><path d="M5 14H255M12 7L5 14L12 21M248 7L255 14L248 21" fill="none" stroke={AMBER} strokeWidth="2" /></svg>
      ) : (
        <div style={styles.receiptTicks}>✓✓</div>
      )}
    </div>
  </Scene>
);

export const EmbassyDemo = () => (
  <AbsoluteFill style={styles.canvas}>
    <div style={styles.glow} />
    <Sequence from={0} durationInFrames={180}><AgentsOverview /></Sequence>
    <Sequence from={180} durationInFrames={180} premountFor={20}>
      <ActionScene duration={180} caption="Claude sends a message to codex-reviewer." captureId="claude-send" title="Claude Code — m5dev" active="claude" token="dlv_TovjWASvZI1_S7O3nIP2IEV8" cameraTo={0} complete />
    </Sequence>
    <Sequence from={360} durationInFrames={150} premountFor={20}>
      <ActionScene duration={150} caption="The Codex task wakes and reads it." captureId="codex-wake" title="Codex CLI — codex-reviewer@m5dev" active="codex" token="dlv_TovjWASvZI1_S7O3nIP2IEV8" cameraTo={10} />
    </Sequence>
    <Sequence from={510} durationInFrames={180} premountFor={20}>
      <ActionScene duration={180} caption="Codex replies." captureId="codex-wake" title="Codex CLI — codex-reviewer@m5dev" active="codex" token="dlv_BVg9Jabf8PiQvIdwpDLr9XFs" sourceStartMs={5000} cameraFrom={0} cameraTo={0} reverse complete highlightPattern="Ran embassy send --conversation" />
    </Sequence>
    <Sequence from={690} durationInFrames={150} premountFor={20}>
      <ActionScene duration={150} caption="The reply arrives in Claude." captureId="claude-reply" title="Claude Code — m5dev" active="claude" token="dlv_BVg9Jabf8PiQvIdwpDLr9XFs" cameraTo={0} reverse complete />
    </Sequence>
    <Sequence from={840} durationInFrames={150} premountFor={20}>
      <FullTuiScene duration={150} captureId="v2-ssh" caption="Other Macs too, over SSH." ssh />
    </Sequence>
    <Sequence from={990} durationInFrames={210} premountFor={20}>
      <FullTuiScene duration={210} captureId="tui-settled" caption="Every delivery has a receipt." />
    </Sequence>
  </AbsoluteFill>
);

const styles: Record<string, CSSProperties> = {
  canvas: {background: INK, color: TEXT, fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif"},
  glow: {position: "absolute", inset: 0, background: `radial-gradient(circle at 50% 48%, ${AMBER}16 0%, transparent 50%)`},
  scene: {padding: "40px 72px 44px", boxSizing: "border-box"},
  brand: {position: "absolute", top: 34, right: 72, display: "flex", alignItems: "center", gap: 11, color: MUTED, fontSize: 28, fontWeight: 650},
  captionArea: {height: 116, paddingRight: 240},
  eyebrow: {fontSize: 28, letterSpacing: "0.15em", textTransform: "uppercase", color: MUTED, fontWeight: 720, marginBottom: 10},
  caption: {fontSize: 48, lineHeight: 1.08, letterSpacing: "-0.025em", fontWeight: 760},
  overviewGrid: {display: "grid", gridTemplateColumns: "430px 850px 430px", justifyContent: "space-between", alignItems: "end", height: 876},
  sidePane: {position: "relative", opacity: 0.9},
  centerPane: {position: "relative"},
  brokerLane: {height: 74, display: "flex", justifyContent: "center", alignItems: "center", gap: 18, color: MUTED, fontSize: 28, fontWeight: 650},
  actionGrid: {position: "relative", display: "grid", columnGap: 8, alignItems: "center"},
  laneTick: {position: "absolute", top: -34, color: AMBER, fontSize: 30, fontWeight: 800},
  brokerColumn: {height: 520, position: "relative", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", color: MUTED},
  brokerWord: {fontSize: 28, letterSpacing: "0.05em", fontWeight: 760, marginBottom: 14},
  direction: {fontSize: 42, color: AMBER, marginTop: 14, lineHeight: 1},
  envelope: {width: 36, height: 36, display: "grid", placeItems: "center", color: AMBER, background: PANEL, border: `1px solid ${AMBER}`, borderRadius: 8, fontSize: 21, marginTop: 13},
  brokerNode: {width: 70, height: 70, border: `1px solid ${AMBER}88`, boxShadow: `0 0 35px ${AMBER}22`, borderRadius: 18, display: "grid", placeItems: "center"},
  receipt: {marginTop: 16, textAlign: "center", color: AMBER, fontSize: 27, fontWeight: 760},
  tokenFlash: {position: "fixed", width: 620, left: "50%", transform: "translateX(-50%)", bottom: 24, color: MUTED, fontFamily: '"SFMono-Regular", Menlo, monospace', textAlign: "center", fontSize: 28, whiteSpace: "nowrap"},
  fullTui: {position: "relative"},
  receiptTicks: {position: "absolute", right: 22, top: -34, color: AMBER, fontSize: 30, fontWeight: 800, letterSpacing: "-0.18em", paddingRight: "0.18em"},
  hostLink: {position: "absolute", left: 400, top: 54},
  bigTicks: {fontSize: 62, color: AMBER, letterSpacing: "-0.2em", paddingRight: "0.2em", lineHeight: 1},
};
