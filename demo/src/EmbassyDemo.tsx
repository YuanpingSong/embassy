import type {CSSProperties, ReactNode} from "react";
import {AbsoluteFill, Easing, Img, interpolate, Sequence, staticFile, useCurrentFrame} from "remotion";
import {TerminalWindow} from "./TerminalWindow";

const AMBER = "#f4a259", TERRA = "#c96442", TEXT = "#eef1f5", MUTED = "#8a8a96", INK = "#131316";
const ease = (f: number, a: number, b: number) => interpolate(f, [a, b], [0, 1], {
  easing: Easing.inOut(Easing.cubic), extrapolateLeft: "clamp", extrapolateRight: "clamp",
});
const Mark = ({size = 62}: {size?: number}) => <Img src={staticFile("mark.svg")} style={{width: size, height: size}} />;
const Caption = ({title, eyebrow}: {title: string; eyebrow: string}) => <header style={styles.caption}>
  <div style={styles.eyebrow}>{eyebrow}</div><h1 style={styles.heading}>{title}</h1>
</header>;
const Scene = ({duration, first = false, children}: {duration: number; first?: boolean; children: ReactNode}) => {
  const f = useCurrentFrame(), enter = first ? 1 : ease(f, 0, 6), leave = ease(f, duration - 6, duration);
  return <AbsoluteFill style={{opacity: enter * (1 - leave), transform: `translateY(${(1 - enter) * 28 - leave * 28}px)`}}>{children}</AbsoluteFill>;
};
const Broker = ({x, y, glow = 0, small = false}: {x: number; y: number; glow?: number; small?: boolean}) => <div style={{position: "absolute", left: x - (small ? 48 : 66), top: y - (small ? 48 : 66), textAlign: "center"}}>
  <div style={{width: small ? 96 : 132, height: small ? 96 : 132, border: "1px solid #634a35", background: "#1a1a1e", borderRadius: 26,
    display: "grid", placeItems: "center", boxShadow: `0 0 ${25 + glow * 55}px ${AMBER}${glow > .1 ? "40" : "0c"}`}}><Mark size={small ? 48 : 70} /></div>
  <div style={{color: MUTED, fontSize: 26, marginTop: 16}}>Embassy</div>
</div>;
const Packet = ({x, y, receipt = false, opacity = 1}: {x: number; y: number; receipt?: boolean; opacity?: number}) => <div style={{position: "absolute", left: x - 39, top: y - 29, width: 78, height: 58, border: `2px solid ${AMBER}`,
  boxSizing: "border-box", borderRadius: 12, background: "#1a1a1e", opacity, boxShadow: `0 0 32px ${AMBER}30`, display: "grid", placeItems: "center"}}>
  {receipt ? <span style={{fontSize: 40, color: AMBER}}>✓</span> : <svg width="68" height="46" viewBox="0 0 68 46"><path d="M5 6L34 26L63 6M5 40L24 23M63 40L44 23" fill="none" stroke={AMBER} strokeWidth={2} /></svg>}
</div>;
const Line = ({x1, x2, y, progress = 0, reverse = false}: {x1: number; x2: number; y: number; progress?: number; reverse?: boolean}) => <svg width={1920} height={1080} style={styles.svg}>
  <path d={`M${x1} ${y}H${x2}`} stroke="#454047" strokeWidth={2} />
  <path d={reverse ? `M${x2} ${y}H${x2 - (x2 - x1) * progress}` : `M${x1} ${y}H${x1 + (x2 - x1) * progress}`} stroke={AMBER} strokeWidth={3} />
</svg>;
const Agent = ({x, y, provider, name, active = false}: {x: number; y: number; provider: string; name: string; active?: boolean}) => <div style={{...styles.agent, left: x, top: y, borderColor: active ? "#926740" : "#393940"}}>
  <div style={{color: MUTED, fontSize: 23, letterSpacing: ".13em", marginBottom: 20}}>AGENT</div>
  <div style={{fontSize: 44, fontWeight: 620, marginBottom: 18}}>{provider}</div>
  <div style={{fontFamily: "Menlo, monospace", fontSize: 28, color: MUTED}}>{name}</div>
</div>;

const Intro = () => {
  const f = useCurrentFrame(), p = ease(f, 24, 94);
  return <Scene duration={120} first>
    <Caption title="Let your agents talk." eyebrow="Claude Code ↔ Codex CLI" />
    <Line x1={710} x2={1210} y={543} progress={p} />
    <Agent x={130} y={420} provider="Claude Code" name="embassy-demo" />
    <Agent x={1210} y={420} provider="Codex CLI" name="codex-reviewer" active={p > .95} />
    <Broker x={960} y={543} glow={Math.sin(p * Math.PI)} />
    {f > 24 && f < 100 ? <Packet x={710 + 500 * p} y={543} /> : null}
    <div style={styles.bottomCaption}>By name. On your machines.</div>
  </Scene>;
};

const Send = () => {
  const f = useCurrentFrame(), p = ease(f, 80, 145);
  return <Scene duration={180}>
    <Caption title="Send by name." eyebrow="One command from Claude" />
    <div style={{position: "absolute", left: 130, top: 330}}>
      <TerminalWindow captureId="claude-send" title="Claude Code · embassy-demo" width={1660} height={160} fontSize={38} lineHeight={1.3}
        sourceStartMs={3034} sourceEndMs={3034} viewportRow={5} viewportRows={1} viewportColumns={60} />
    </div>
    <Line x1={340} x2={1520} y={700} progress={p} />
    <div style={{...styles.label, left: 130, top: 755}}>Claude Code</div>
    <div style={{...styles.label, right: 130, top: 755}}>Codex CLI</div>
    <Broker x={960} y={700} small glow={Math.sin(p * Math.PI)} />
    {f >= 80 ? <Packet x={340 + 1180 * p} y={700} opacity={1 - ease(f, 160, 174)} /> : null}
    <div style={styles.bottomCaption}>No session IDs to copy.</div>
  </Scene>;
};

const Wake = () => {
  const f = useCurrentFrame(), p = ease(f, 18, 75);
  return <Scene duration={180}>
    <Caption title="The Codex agent wakes up." eyebrow="It arrives in Codex" />
    <Line x1={230} x2={720} y={540} progress={p} />
    <Broker x={230} y={540} small glow={1 - p} />
    <div style={{position: "absolute", top: 375, left: 440, opacity: .3 + .7 * ease(f, 60, 84)}}>
      <TerminalWindow captureId="codex-wake" title="Codex CLI · codex-reviewer" width={1370} height={330} fontSize={30} lineHeight={1.3}
        sourceStartMs={87} sourceEndMs={4993} viewportRow={6} viewportRows={6} viewportColumns={73} focusRows={[0, 5]} />
    </div>
    {f < 90 ? <Packet x={230 + 490 * p} y={540} opacity={1 - ease(f, 73, 88)} /> : null}
    <div style={styles.bottomCaption}>Delivered straight into the Codex session. Nothing polls.</div>
  </Scene>;
};

const Reply = () => {
  const f = useCurrentFrame(), p = ease(f, 65, 145);
  return <Scene duration={180}>
    <Caption title="Codex answers in the same conversation." eyebrow="Codex replies" />
    <div style={{position: "absolute", left: 360, top: 330}}>
      <TerminalWindow captureId="codex-wake" title="Codex CLI · codex-reviewer" width={1200} height={150} fontSize={36} lineHeight={1.4}
        sourceStartMs={5000} sourceEndMs={5000} viewportRow={4} viewportRows={1} viewportColumns={49}
        highlightPattern="Ran embassy send --conversation" accent={TERRA} />
    </div>
    <Line x1={340} x2={1580} y={700} progress={p} reverse />
    <div style={{...styles.label, left: 130, top: 755}}>Claude Code</div>
    <div style={{...styles.label, right: 130, top: 755}}>Codex CLI</div>
    <Broker x={960} y={700} small glow={Math.sin(p * Math.PI)} />
    {f >= 65 ? <Packet x={1580 - 1240 * p} y={700} opacity={1 - ease(f, 160, 174)} /> : null}
    <div style={styles.bottomCaption}>The reply can only go back to whoever asked.</div>
  </Scene>;
};

const Arrival = () => {
  const f = useCurrentFrame();
  return <Scene duration={150}>
    <Caption title="Back in Claude." eyebrow="The loop closes" />
    <div style={{position: "absolute", left: 360, top: 380}}>
      <TerminalWindow captureId="claude-reply" title="Claude Code · embassy-demo" width={1200} height={165} fontSize={34} lineHeight={1.4}
        sourceStartMs={2000} sourceEndMs={2000} viewportRow={11} viewportRows={1} viewportColumns={49} />
    </div>
    <div style={{position: "absolute", top: 635, width: "100%", textAlign: "center", opacity: ease(f, 25, 45)}}>
      <span style={{display: "inline-block", color: AMBER, fontSize: 66, marginRight: 22}}>✓</span><span style={{fontSize: 42}}>Reply received.</span>
    </div>
  </Scene>;
};

const Mac = ({x, host, provider}: {x: number; host: string; provider: string}) => <div style={{position: "absolute", left: x, top: 345, width: 610, height: 400}}>
  <div style={{height: 356, border: "2px solid #57535c", borderRadius: 24, background: "#1a1a1e", padding: 32, boxSizing: "border-box"}}>
    <div style={{fontSize: 34, fontWeight: 620}}>{host}</div>
    <div style={{position: "absolute", top: 105, left: 150, width: 310, height: 70, display: "grid", placeItems: "center", background: "#232328", border: "1px solid #4c4851", borderRadius: 35, fontSize: 28}}>{provider}</div>
    <div style={{position: "absolute", left: 303, top: 175, height: 37, borderLeft: "2px solid #57535c"}} />
    <div style={{position: "absolute", left: 211, top: 212, display: "flex", alignItems: "center", gap: 14}}><Mark size={44} /><span style={{fontSize: 28}}>Embassy</span></div>
  </div>
  <div style={{position: "absolute", top: 357, left: 225, width: 160, height: 36, background: "#39373e", clipPath: "polygon(25% 0,75% 0,90% 100%,10% 100%)"}} />
  <div style={{position: "absolute", top: 393, left: 155, width: 300, height: 7, background: "#77717c", borderRadius: 6}} />
</div>;
const Ssh = () => {
  const f = useCurrentFrame(), outbound = ease(f, 24, 100), inbound = ease(f, 120, 188), returning = f >= 120;
  return <Scene duration={210}>
    <Caption title="Across Macs. Over SSH." eyebrow="More than one Mac" />
    <Mac x={140} host="m5dev" provider="Claude agent" />
    <Mac x={1170} host="this-mac" provider="Codex agent" />
    <div style={{position: "absolute", right: 140, top: 795, color: MUTED, fontSize: 23}}>illustration</div>
    <Line x1={750} x2={1170} y={580} progress={returning ? inbound : outbound} reverse={returning} />
    <div style={{position: "absolute", left: 880, top: 500, width: 160, textAlign: "center", fontSize: 32, letterSpacing: ".12em", color: MUTED}}>SSH</div>
    {f >= 24 && f < 200 ? <Packet x={returning ? 1170 - 420 * inbound : 750 + 420 * outbound} y={580} receipt={returning} /> : null}
    <div style={styles.bottomCaption}>{returning ? "A receipt comes back." : "The message crosses over SSH."}</div>
  </Scene>;
};

const Receipts = () => {
  const f = useCurrentFrame(), step = f < 30 ? 0 : f < 65 ? 1 : 2;
  return <Scene duration={180}>
    <Caption title="Receipts, not guesswork." eyebrow="Follow the outcome" />
    <div style={{position: "absolute", top: 330, left: 310, display: "flex", alignItems: "center", gap: 38}}>
      {["send", "accepted", "delivered"].map((label, i) => <div key={label} style={{display: "flex", alignItems: "center", gap: 38}}>
        {i > 0 ? <span style={{fontSize: 40, color: MUTED}}>→</span> : null}
        <div style={{width: 340, padding: "28px 0", textAlign: "center", borderRadius: 18, border: `1px solid ${i <= step ? AMBER : "#434049"}`, background: "#1a1a1e", color: i <= step ? TEXT : MUTED, fontSize: 37}}>{i === 2 && step === 2 ? <span style={{color: AMBER}}>✓ </span> : null}{label}</div>
      </div>)}
    </div>
    <div style={{position: "absolute", top: 575, left: 110, opacity: ease(f, 70, 90)}}>
      <TerminalWindow captureId="tui-settled" title="embassy tui · deliveries" width={1700} height={170} fontSize={31} lineHeight={1.4}
        sourceEndMs={4000} viewportRow={5} viewportRows={2} viewportColumns={82} />
    </div>
    <div style={styles.bottomCaption}>Delivered means it arrived, not that it was read.</div>
  </Scene>;
};

export const EmbassyDemo = () => <AbsoluteFill style={styles.canvas}>
  <AbsoluteFill style={{background: "radial-gradient(ellipse at 50% 48%, #252127 0%, #131316 72%)"}} />
  <Sequence from={0} durationInFrames={132}><Intro /></Sequence>
  <Sequence from={120} durationInFrames={192}><Send /></Sequence>
  <Sequence from={300} durationInFrames={192}><Wake /></Sequence>
  <Sequence from={480} durationInFrames={192}><Reply /></Sequence>
  <Sequence from={660} durationInFrames={162}><Arrival /></Sequence>
  <Sequence from={810} durationInFrames={222}><Ssh /></Sequence>
  <Sequence from={1020} durationInFrames={180}><Receipts /></Sequence>
  <div style={styles.brand}><Mark size={36} /><span>Embassy</span></div>
</AbsoluteFill>;
const styles: Record<string, CSSProperties> = {
  canvas: {background: INK, color: TEXT, fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif"},
  caption: {position: "absolute", left: 130, top: 88},
  eyebrow: {fontSize: 25, letterSpacing: ".13em", textTransform: "uppercase", color: MUTED},
  heading: {fontSize: 68, fontWeight: 630, letterSpacing: "-.035em", lineHeight: 1.1, margin: "20px 0 0"},
  brand: {position: "absolute", top: 68, right: 80, display: "flex", gap: 10, alignItems: "center", fontSize: 26, color: MUTED},
  agent: {position: "absolute", width: 580, height: 246, border: "1px solid #393940", borderRadius: 26, padding: 34, boxSizing: "border-box", background: "#1a1a1e"},
  bottomCaption: {position: "absolute", top: 910, width: "100%", textAlign: "center", color: MUTED, fontSize: 33},
  label: {position: "absolute", fontSize: 31, color: MUTED},
  svg: {position: "absolute", inset: 0, pointerEvents: "none"},
};
