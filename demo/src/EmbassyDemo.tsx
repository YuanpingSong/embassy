import type {CSSProperties, ReactNode} from "react";
import {AbsoluteFill, Easing, Img, interpolate, Sequence, staticFile, useCurrentFrame} from "remotion";
import {TerminalWindow} from "./TerminalWindow";

const AMBER = "#f4a259", TERRA = "#c96442", TEXT = "#eef1f5", MUTED = "#8a8a96";
const ease = (frame: number, from: number, to: number) => interpolate(frame, [from, to], [0, 1], {
  easing: Easing.inOut(Easing.cubic), extrapolateLeft: "clamp", extrapolateRight: "clamp",
});
const Window = TerminalWindow;

const Chapter = ({number, title, note}: {number: string; title: string; note: string}) => (
  <header style={{position: "absolute", top: 66, left: 80}}>
    <div style={{color: MUTED, fontSize: 25, letterSpacing: "0.14em", marginBottom: 14}}>{number} / {note.toUpperCase()}</div>
    <div style={{fontSize: 64, fontWeight: 650, letterSpacing: "-0.045em", lineHeight: 1.05}}>{title}</div>
  </header>
);
const Scene = ({duration, children, first = false}: {duration: number; children: ReactNode; first?: boolean}) => {
  const f = useCurrentFrame();
  const incoming = first ? 1 : ease(f, 0, 14);
  const outgoing = ease(f, duration, duration + 14);
  return <AbsoluteFill style={{height: 920, overflow: "hidden", transform: `translateX(${((1 - incoming) - outgoing) * 1920}px)`}}>{children}</AbsoluteFill>;
};

const Overview = () => {
  const f = useCurrentFrame(), joined = ease(f, 48, 70);
  return <Scene duration={180} first>
    <Chapter number="01" title="Your agents. On speaking terms." note="Claude Code ↔ Codex CLI" />
    <div style={{position: "absolute", top: 380, left: 80, display: "flex", gap: 40,
      opacity: 1 - ease(f, 42, 58), transform: `translateY(${-joined * 75}px) scale(${1 - joined * .04})`}}>
      <Window captureId="v2-claude-agents" title="claude agents" width={800} height={210} fontSize={36}
        lineHeight={1.25} viewportRow={9} viewportRows={2} viewportColumns={29} />
      <Window captureId="v2-codex-agents" title="codex agents" width={920} height={210} fontSize={34}
        lineHeight={1.25} viewportRow={18} viewportRows={2} cameraColumn={2} viewportColumns={38} />
    </div>
    <div style={{position: "absolute", top: 205, left: 155,
      transform: `translateY(${(1 - joined) * 1000}px)`}}>
      <Window captureId="v2-tui-overview" title="embassy tui · m5dev" width={1610} height={714} fontSize={28}
        lineHeight={1} viewportRow={5} viewportRows={23} viewportColumns={86} />
    </div>
    <div style={{position: "absolute", top: 630, width: "100%", textAlign: "center", fontSize: 32, color: MUTED, opacity: 1 - ease(f, 42, 48)}}>
      Real sessions. Addressed by name.
    </div>
  </Scene>;
};
const Send = () => <Scene duration={180}>
  <Chapter number="02" title="Ask by name." note="Claude sends" />
  <div style={styles.hero}>
    <Window captureId="claude-send" title="Claude Code · embassy-demo@m5dev" width={1760} height={520}
      fontSize={31} lineHeight={1.18} sourceStartMs={2410} sourceEndMs={5152} focusPattern="printf" viewportRows={12} viewportColumns={90} />
  </div>
</Scene>;
const Wake = () => <Scene duration={150}>
  <Chapter number="03" title="It wakes in Codex." note="Native receiving" />
  <div style={styles.hero}>
    <Window captureId="codex-wake" title="Codex CLI · codex-reviewer@m5dev" width={1760} height={530}
      fontSize={31} lineHeight={1.18} sourceStartMs={87} sourceEndMs={4993} viewportRows={12} viewportColumns={90} />
  </div>
</Scene>;
const Reply = () => <Scene duration={180}>
  <Chapter number="04" title="Reply in the same conversation." note="Codex replies" />
  <div style={styles.hero}>
    <Window captureId="codex-wake" title="Codex CLI · codex-reviewer@m5dev" width={1760} height={440}
      fontSize={31} lineHeight={1.18} sourceStartMs={5000} sourceEndMs={7426} viewportRow={4} viewportRows={9}
      viewportColumns={90} highlightPattern="Ran embassy send --conversation" accent={TERRA} />
  </div>
</Scene>;
const Arrive = () => <Scene duration={150}>
  <Chapter number="05" title="Back in Claude. Natively." note="The loop closes" />
  <div style={{...styles.hero, top: 260}}>
    <Window captureId="claude-reply" title="Claude Code · embassy-demo@m5dev" width={1760} height={615}
      fontSize={31} lineHeight={1.12} sourceStartMs={2000} sourceEndMs={2000} viewportRow={1} viewportRows={15} viewportColumns={90} />
  </div>
</Scene>;
const Ssh = () => <Scene duration={150}>
  <Chapter number="06" title="Other Macs, too." note="Over SSH" />
  <div style={{...styles.hero, top: 240}}>
    <Window captureId="v2-ssh" title="embassy tui · switching hosts with ]" width={1760} height={640}
      fontSize={30} lineHeight={1.08} viewportRows={17} viewportColumns={90} />
  </div>
</Scene>;
const Ledger = () => <Scene duration={210}>
  <Chapter number="07" title="Every delivery has a receipt." note="The real ledger" />
  <div style={{...styles.hero, top: 350}}>
    <Window captureId="tui-settled" title="embassy tui · deliveries" width={1760} height={306}
      fontSize={30} lineHeight={1.13} sourceEndMs={4000} viewportRows={7} viewportColumns={90} />
    <div style={{position: "absolute", left: 18, right: 113, top: 223, height: 69, border: `2px solid ${AMBER}`, borderRadius: 3, pointerEvents: "none"}} />
  </div>
</Scene>;

// One persistent path joins the cuts. Motion illustrates direction, not packet timing.
const Journey = () => {
  const f = useCurrentFrame(), ssh = f >= 840 && f < 990;
  const outbound = ease(f, 294, 394), inbound = ease(f, 616, 724);
  const position = ssh ? 260 + 1400 * ease(f, 866, 934) : f < 510 ? 260 + 1400 * outbound : 1660 - 1400 * inbound;
  const moving = ssh ? f >= 866 && f < 938 : (f >= 290 && f <= 410) || (f >= 612 && f <= 740);
  const received = f >= 394, replied = f >= 724;
  return <div style={{position: "absolute", left: 0, right: 0, top: 940, height: 105}}>
    <svg width={1920} height={88} style={{position: "absolute", top: 0}}>
      <path d="M260 30H1660" stroke="#3b3837" strokeWidth={2} />
      <path d={f < 510 ? `M260 30H${260 + 1400 * outbound}` : `M1660 30H${1660 - 1400 * inbound}`}
        stroke={AMBER} strokeWidth={2} opacity={f < 290 || ssh ? 0 : .75} />
      {[260, 1660].map(x => <circle key={x} cx={x} cy={30} r={6} fill={AMBER} />)}
    </svg>
    <div style={{position: "absolute", top: -2, left: 928, width: 64, height: 64, display: "grid", placeItems: "center",
      background: "#131316", border: "1px solid #4b3b2d", borderRadius: 16,
      boxShadow: moving ? `0 0 ${24 + 12 * Math.sin(f / 6)}px ${AMBER}30` : "none"}}>
      <Img src={staticFile("mark.svg")} style={{width: 40, height: 40}} />
    </div>
    {moving ? <div style={{position: "absolute", top: 6, left: position - 28, width: 56, height: 44,
      borderRadius: 9, background: "#1a1a1e", border: `2px solid ${AMBER}`, boxShadow: `0 0 24px ${AMBER}55`}}>
      <svg width="52" height="40" viewBox="0 0 52 40"><path d="M5 7L26 23L47 7M5 33L18 22M47 33L34 22" stroke={AMBER} strokeWidth="2" fill="none" /></svg>
    </div> : null}
    <div style={{...styles.actor, left: 80, textAlign: "left"}}>{ssh ? "m5dev" : "Claude Code"}{replied && !ssh ? <span style={styles.tick}> ✓</span> : null}</div>
    <div style={{...styles.actor, right: 80, textAlign: "right"}}>{ssh ? "this-mac" : "Codex CLI"}{received && !ssh ? <span style={styles.tick}> ✓</span> : null}</div>
    <div style={{position: "absolute", top: 76, width: "100%", textAlign: "center", color: MUTED, fontSize: 23}}>
      {ssh ? "SSH · your machines" : f < 180 ? "One gateway. Both providers." : f < 510 ? "request →" : f < 840 ? "← reply" : "request + reply · delivered"}
    </div>
  </div>;
};
export const EmbassyDemo = () => <AbsoluteFill style={styles.canvas}>
  <AbsoluteFill style={{background: "radial-gradient(ellipse at 50% 48%, #242024 0%, #131316 72%)"}} />
  <Sequence from={0} durationInFrames={194}><Overview /></Sequence>
  <Sequence from={180} durationInFrames={194}><Send /></Sequence>
  <Sequence from={360} durationInFrames={164}><Wake /></Sequence>
  <Sequence from={510} durationInFrames={194}><Reply /></Sequence>
  <Sequence from={690} durationInFrames={164}><Arrive /></Sequence>
  <Sequence from={840} durationInFrames={164}><Ssh /></Sequence>
  <Sequence from={990} durationInFrames={210}><Ledger /></Sequence>
  <Journey />
  <div style={styles.brand}><Img src={staticFile("mark.svg")} style={{width: 38, height: 38}} /><span>Embassy</span></div>
</AbsoluteFill>;
const styles: Record<string, CSSProperties> = {
  canvas: {background: "#131316", color: TEXT, fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif"},
  hero: {position: "absolute", left: 80, top: 310},
  brand: {position: "absolute", top: 52, right: 72, padding: 8, background: "#131316", borderRadius: 8, display: "flex", alignItems: "center", gap: 10, color: MUTED, fontSize: 27, fontWeight: 600},
  actor: {position: "absolute", top: 56, fontSize: 29, fontWeight: 600}, tick: {color: AMBER},
};
