import {useEffect, useState, type CSSProperties, type ReactNode} from 'react';
import {AbsoluteFill, Easing, cancelRender, continueRender, delayRender, interpolate, interpolateColors, staticFile, useCurrentFrame} from 'remotion';
import {DispatchCard, enter, Packet, progress, Route, travel} from './components';
import {carryPacket} from './carry';
import {palette as p, scenes, type} from './design';
import {recorded, claudeHintRows} from './recorded';

const mono = type.mono.fontFamily;
const box = (left: number, top: number, width?: number, height?: number): CSSProperties => ({position: 'absolute', left, top, width, height, boxSizing: 'border-box'});
const Mark = ({size = 64}: {size?: number}) => <svg width={size} height={size} viewBox="0 0 64 64" fill="none"><path d="M32 16 V5 L41 7.5 L32 10" fill={p.amber} stroke={p.amber} strokeWidth={1.5} strokeLinejoin="round"/><path d="M21.5 55 V32 C21.5 23 42.5 23 42.5 32 V55 Z" fill={p.amber}/><path d="M14 55 V30.5 C14 17 50 17 50 30.5 V55" stroke={p.ink} strokeWidth={3.4} strokeLinecap="round"/><path d="M10 55.5 H54" stroke={p.ink} strokeWidth={3} strokeLinecap="round"/></svg>;
const pulse = (f: number, start: number) => interpolateColors(progress(f, start, start + 12), [0, .5, 1], [p.line, p.amberInk, p.line]);
const label = (left: number, top: number, width: number): CSSProperties => ({...box(left, top, width), textAlign: 'center', fontFamily: mono, fontSize: 22, letterSpacing: '.08em', color: p.muted});
const Node = ({y = 620, hot = false}: {y?: number; hot?: boolean}) => <><div style={{...box(900, y, 120, 120), display: 'grid', placeItems: 'center', background: p.card, border: `${hot ? 2 : 1}px solid ${hot ? p.amberInk : p.line}`, borderRadius: 12}}><Mark/></div><div style={label(850, y + (y === 480 ? 144 : 136), 220)}>EMBASSY</div></>;
const Check = ({size = 28}: {size?: number}) => <svg width={size} height={size} viewBox="0 0 28 28"><path d="M4 15 L11 22 L24 6" fill="none" stroke={p.ink} strokeWidth={3} strokeLinecap="round" strokeLinejoin="round"/></svg>;
const stampScale = (f: number, start: number) => interpolate(f, [start, start + 5, start + 8], [1.18, .97, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
const masked = (text: string): ReactNode => text.split(/(^[•◦]|❯)/).map((part, i) => <span key={i} style={{color: /^[•◦]$/.test(part) ? p.moss : part === '❯' ? p.amber : undefined}}>{part}</span>);
const ledgerNames = (text: string) => {
  const arrow = text.indexOf(' -> ');
  return arrow < 0 ? masked(text) : <>{masked(text.slice(0,arrow))}{text.slice(arrow)}</>;
};
function Transcript({lines, f, start, emphasis = -1, answer = false}: {lines: readonly string[]; f: number; start: number; emphasis?: number; answer?: boolean}) {
  return <>{lines.map((line, i) => {
    const t = progress(f, start + i * 3, start + i * 3 + 8);
    const hanging = line.includes('│') ? '4ch' : line.startsWith('  ') ? '2ch' : undefined;
    return <div key={i} style={{minHeight: line ? undefined : 40, ...(hanging ? {paddingLeft:hanging,textIndent:`-${hanging}`} : {}), opacity: t, transform: `translateY(${6 * (1 - t)}px)`, color: i === emphasis ? p.paper : answer && line.includes('│') && !line.includes('…') ? p.moss : line.includes('Working') || line.startsWith('@') || line.startsWith('• Ran') || line.startsWith('⏺') ? p.paper : p.dimDark, fontWeight: i === emphasis ? 500 : 400, ...(i === emphasis ? {background: p.band, margin: '0 -40px', padding: '0 40px'} : {})}}>{line.includes('Working') || line.includes('Creating') ? <><span style={{color: Math.floor(f / 10) % 2 ? p.dimDark : line.includes('Creating') ? p.ember : p.moss}}>{line[0]}</span>{masked(line.slice(1))}</> : masked(line)}</div>;
  })}</>;
}
function Intro({f}: {f: number}) {
  const t = travel(f, 46, 100);
  return <><Route x1={760} x2={1160} y={539} amount={t}/>{[false, true].map((right) => <div key={String(right)} style={{...box(right ? 1160 : 120, 420, 640, 240), background: p.card, border: `${right && f >= 100 || !right && f >= 30 && f < 42 ? 2 : 1}px solid ${right && f >= 100 ? p.amberInk : !right ? pulse(f, 30) : p.line}`, borderRadius: 8, padding: '36px 40px'}}>
    <div style={{fontFamily: mono, fontSize: 20, letterSpacing: '.14em', color: p.dim}}>AGENT</div>
    <div style={{display: 'flex', gap: 18, alignItems: 'center', fontSize: 48, lineHeight: '56px', fontWeight: 600, marginTop: 20}}><span style={{width: 14, height: 14, borderRadius: '50%', background: right ? p.ink : p.emberInk}}/>{right ? 'Codex CLI' : 'Claude Code'}</div>
    <div style={{fontFamily: mono, fontSize: 30, color: p.muted, marginTop: 12}}>{right ? 'codex-reviewer' : 'embassy-demo'}</div>
  </div>)}<Node y={480} hot={f >= 70}/>{f >= 42 && <Packet x={732 + 372 * t} y={520} opacity={progress(f, 42, 46) * (1 - progress(f, 140, 146))}/>}</>;
}
function SendReply({f, reverse}: {f: number; reverse: boolean}) {
  const start = reverse ? 510 : 150;
  const a = reverse ? 560 : 230, b = reverse ? 612 : 266, end = reverse ? 659 : 299;
  const command = reverse ? recorded.replyCommand : recorded.send.slice(0, Math.max(0, (f - 170) * 3));
  return <>
    <DispatchCard x={120} y={320} width={1680} height={reverse ? 166 : 192} product={reverse ? 'CODEX CLI' : 'CLAUDE CODE'} handle={reverse ? 'codex-reviewer' : 'embassy-demo'} provider={reverse ? 'codex' : 'claude'} oneLine={reverse} bodyPadding={reverse ? undefined : '28px 40px'} style={enter(f, start + 6)}>
      <span>{reverse ? <>{masked(command.split(" <<")[0])}<span style={{color:p.dimDark}}>{" <<'MESSAGE'"}</span></> : command}</span>{!reverse && f >= 170 && (f < 213 || Math.floor(f / 15) % 2 === 0) && <span style={{background: p.paper, display: 'inline-block', width: '.6em', height: '1.05em', verticalAlign: 'middle'}}/>}
      {reverse && <svg width={1190} height={60} style={{position: 'absolute', left: 32, top: 25, pointerEvents: 'none'}}><rect x={1} y={1} width={1188} height={58} rx={12} fill="none" stroke={p.amber} strokeWidth={2} pathLength={1} strokeDasharray={1} strokeDashoffset={1 - progress(f, 534, 542)}/></svg>}
      {!reverse && <div style={{position: 'absolute', left: 40 + 20 * 16.8, top: 109, width: 14 * 16.8 * progress(f, 214, 222), height: 3, background: p.amber}}/>}
    </DispatchCard>
    <Route x1={120} x2={900} y={679} amount={reverse ? progress(f, b, end) : travel(f, a, b)} reverse={reverse} dashed={reverse}/><Route x1={1020} x2={1800} y={679} amount={reverse ? travel(f, a, b) : progress(f, b, end)} reverse={reverse} dashed={!reverse}/>
    <Node hot={f >= b - 12}/><div style={{...label(120, 756, 300), textAlign: 'left', fontFamily: 'IBM Plex Sans', fontSize: 30, fontWeight: 500, letterSpacing: 0}}>Claude Code</div><div style={{...label(1500, 756, 300), textAlign: 'right', fontFamily: 'IBM Plex Sans', fontSize: 30, fontWeight: 500, letterSpacing: 0}}>Codex CLI</div>
  </>;
}
function ClaudeScroll({f}: {f: number}) {
  const lines = [recorded.claudeExpanded[0],claudeHintRows,recorded.claudeExpanded[2],recorded.claudeExpanded[3],recorded.claudeExpanded[5]];
  const counts = [1, 4, 5, 1, 4];
  const starts = Array.from({length:15}, (_, i) => i < 10 ? 740 + i * 3 : 770 + (i - 10) * 5);
  const rowProgress = starts.map(start => Easing.bezier(.2,.7,.2,1)(progress(f, start, Math.min(start + 8,800))));
  const scroll = Math.min(156, starts.slice(11).reduce((sum,start) => sum + 40 * Easing.bezier(.2,.7,.2,1)(progress(f,start,Math.min(start+12,800))),0));
  let row = 0;
  return <div style={{position:'absolute',left:40,right:40,top:28,transform:`translateY(${-scroll}px)`}}>{lines.map((line,i)=>{
    const offset=row; row+=counts[i];
    const visible=rowProgress.slice(offset,row).reduce((sum,t)=>sum+t,0)*40;
    return <div key={i} style={{height:counts[i]*40,clipPath:`inset(0 0 ${Math.max(0,counts[i]*40-visible)}px 0)`, color:i===1?p.dimDark:p.paper, ...(i===1?{paddingLeft:'2ch',textIndent:'-2ch'}:{}), ...(i===2?{background:p.band,margin:'0 -40px',padding:'0 40px 0 calc(40px + 2ch)',fontWeight:500}:{}), ...(i===4?{paddingLeft:'2ch',textIndent:'-2ch'}:{})} as CSSProperties}>{masked(line)}</div>;
  })}</div>;
}
function Receive({f, claude}: {f: number; claude: boolean}) {
  const start = claude ? 660 : 300, change = claude ? 732 : 420;
  const expanded = f >= change + 8;
  const arrival = [recorded.codexArrival[0], '⋯', recorded.codexArrival[2], recorded.codexArrival[4], '', recorded.codexArrival[6]];
  const answer = recorded.codexAnswer.filter((_, i) => i !== 4 && i !== 5);
  const lines = claude ? recorded.claudeArrival : expanded ? answer : arrival;
  return <>
    <DispatchCard x={120} y={296} width={1680} height={560} product={claude ? 'CLAUDE CODE' : 'CODEX CLI'} handle={claude ? 'embassy-demo' : 'codex-reviewer'} provider={claude ? 'claude' : 'codex'} scrollBody={claude && expanded} style={{...enter(f, start + 6), ...(f >= start + 18 ? claude ? {borderRightColor: p.amber} : {borderLeftColor: p.amber} : {})}}>
      {claude && expanded ? <ClaudeScroll f={f}/> : <div style={{opacity: !expanded ? 1 - progress(f, change, change + 8) : 1}}><Transcript lines={lines} f={f} start={expanded ? change + 8 : start + 24} emphasis={claude ? -1 : expanded ? -1 : 2} answer={!claude && expanded}/></div>}
    </DispatchCard>
    {claude && f >= 780 && <div style={{...box(806, 912, 398, 84), display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 18, background: p.amber, border: `2px solid ${p.amberInk}`, borderRadius: 6, fontSize: 40, fontWeight: 500, opacity: f < 782 ? 0 : 1, transform: `rotate(-2deg) scale(${stampScale(f, 780)})`}}><Check size={36}/>Reply received.</div>}
  </>;
}
function SSH({f}: {f: number}) {
  const receipt = f >= 966;
  return <>
    <Route x1={760} x2={1160} y={579} dashed amount={travel(f, 888, 940)}/>
    {[false, true].map(right => <div key={String(right)} style={{...box(right ? 1160 : 120, 340, 640, 320), ...enter(f, right ? 852 : 846), background: p.card, border: `1px solid ${pulse(f, right ? 940 : 1008)}`, borderRadius: 10, padding: '36px 40px'}}>
      <div style={{fontSize: 40, lineHeight: '48px', fontWeight: 600}}>{right ? 'Another Mac' : 'This Mac'}</div>
      <div style={{...box(180, 104, 280, 64), borderRadius: 32, border: `1px solid ${p.line}`, background: p.ground, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 14, fontSize: 28, fontWeight: 500}}><span style={{width: 12, height: 12, borderRadius: '50%', background: right ? p.ink : p.emberInk}}/>{right ? 'Codex agent' : 'Claude agent'}</div>
      <div style={{...box(319, 168, 2, 40), background: p.line}}/>
      <div style={{...box(232, 216), display: 'flex', gap: 12, alignItems: 'center', fontFamily: mono, fontSize: 22, letterSpacing: '.08em', color: p.muted}}><Mark size={40}/>EMBASSY</div>
      <div style={{...box(64, 324, 512, 8), background: p.line, borderRadius: '0 0 6px 6px'}}/>
    </div>)}
    <div style={{...label(860, 510, 200), letterSpacing: '.2em', opacity: progress(f, 866, 874)}}>SSH</div>
    <div style={{...box(1500, 700, 300), textAlign: 'right', fontFamily: mono, fontSize: 18, letterSpacing: '.12em', color: p.dim, opacity: progress(f, 870, 878)}}>ILLUSTRATION</div>
    {f >= 884 && <Packet x={receipt ? 1104 - 400 * travel(f, 972, 1008) : 704 + 456 * travel(f, 888, 940)} y={560} receipt={receipt} opacity={receipt ? progress(f, 966, 970) : progress(f, 884, 888) * (1 - progress(f, 952, 960))}/>}
  </>;
}
function Receipts({f}: {f: number}) {
  return <>
    {['send', 'accepted', 'delivered'].map((name, i) => {
      const start = [1036, 1054, 1074][i];
      return <div key={name} style={{...box(312 + i * 468, 424, 360, 96), display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 14, fontFamily: mono, fontSize: 32, fontWeight: 500, background: i === 2 ? p.amber : p.card, border: `2px solid ${p.amberInk}`, borderRadius: 6, opacity: f < start + 2 ? 0 : 1, transform: `scale(${stampScale(f, start)})`}}>{i === 2 && <Check size={30}/>} {name}</div>;
    })}
    {[696, 1164].map((x, i) => <svg key={x} width={80} height={24} style={{...box(x, 460), opacity: progress(f, 1046 + i * 18, 1052 + i * 18)}}><path d="M0 12H78M69 3L78 12L69 21" fill="none" stroke={p.dim} strokeWidth={2}/></svg>)}
    <DispatchCard x={120} y={560} width={1680} height={212} product="EMBASSY TUI" handle="deliveries" provider="tui" oneLine bodyPadding="26px 40px" style={enter(f, 1090)}>
      {recorded.ledger.map((line, i) => <div key={i} style={{opacity: progress(f, i ? 1104 : 1112, i ? 1112 : 1120), color: p.paper, ...(i === 0 ? {background: p.lineDark, margin: '0 -40px', padding: '0 40px', '--mask-stripe': '#4A434A'} : {})} as CSSProperties}>{line.split(/(delivered|^>|\d+[sm] ago)/).map((part, n) => <span key={n} style={{color: part === '>' ? p.amber : /ago$/.test(part) && i ? p.dimDark : part === 'delivered' && i ? p.moss : undefined, fontWeight: part === 'delivered' ? 500 : undefined}}>{ledgerNames(part)}</span>)}</div>)}
    </DispatchCard>
  </>;
}
export function Film() {
  const f = useCurrentFrame();
  const [handle] = useState(() => delayRender('Load bundled design fonts'));
  useEffect(() => {Promise.all([
    new FontFace('Newsreader', `url(${staticFile('fonts/Newsreader.ttf')})`, {weight: '200 800'}),
    new FontFace('IBM Plex Sans', `url(${staticFile('fonts/IBMPlexSans.ttf')})`, {weight: '100 700'}),
    new FontFace('IBM Plex Mono', `url(${staticFile('fonts/IBMPlexMono-Regular.ttf')})`, {weight: '400'}),
    new FontFace('IBM Plex Mono', `url(${staticFile('fonts/IBMPlexMono-Medium.ttf')})`, {weight: '500'}),
    new FontFace('IBM Plex Mono', `url(${staticFile('fonts/IBMPlexMono-SemiBold.ttf')})`, {weight: '600'}),
  ].map(async font => {await font.load(); document.fonts.add(font);})).then(() => continueRender(handle)).catch(cancelRender);}, [handle]);
  const index = scenes.findIndex(scene => f >= scene.start && f < scene.end);
  const scene = scenes[index];
  const leave = index === 6 ? 1 : 1 - progress(f, scene.end - 8, scene.end);
  const captionStart = [0, 222, 360, 548, 800, 876, 1136][index];
  const caption = index === 5 && f >= 966 ? 'A receipt comes back.' : scene.caption;
  const packet = carryPacket(f, Easing.bezier(.45,0,.2,1));
  return <AbsoluteFill style={{background: p.ground, color: p.ink, fontFamily: 'IBM Plex Sans'}}>
    <div style={{opacity: leave}}>
      <div style={index === 0 ? undefined : enter(f, scene.start)}><div style={{...box(120, 92), display: 'flex', alignItems: 'baseline', gap: 24, fontFamily: mono, fontSize: 24, lineHeight: '32px', letterSpacing: '.14em', fontWeight: 500, color: p.muted}}><span style={{color: p.amberInk, letterSpacing: '.06em'}}>{String(index + 1).padStart(2, '0')}</span>{scene.eyebrow}</div><div style={{...box(116, 140), ...type.headline, whiteSpace: 'nowrap', fontOpticalSizing: 'auto'}}>{scene.headline}</div></div>
      {index === 0 ? <Intro f={f}/> : index === 1 || index === 3 ? <SendReply f={f} reverse={index === 3}/> : index === 2 || index === 4 ? <Receive f={f} claude={index === 4}/> : index === 5 ? <SSH f={f}/> : <Receipts f={f}/>}
      {index !== 4 && <div style={{...box(260, 920, 1400), ...type.caption, textAlign: 'center', color: p.muted, opacity: index === 0 ? 1 : progress(f, captionStart, captionStart + 8)}}>{caption}</div>}
    </div>
    {packet && <Packet {...packet}/>}
    <div style={{position: 'absolute', right: 120, top: 72, display: 'flex', gap: 12, alignItems: 'center', fontSize: 26, fontWeight: 500}}><Mark size={40}/>Embassy</div>
  </AbsoluteFill>;
}
