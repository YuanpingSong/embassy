import type {CSSProperties, ReactNode} from 'react';
import {Easing, interpolate} from 'remotion';
import {palette as p, type} from './design';

export const progress = (frame: number, start: number, end: number) => interpolate(frame, [start, end], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
export const travel = (frame: number, start: number, end: number) => Easing.bezier(.45, 0, .2, 1)(progress(frame, start, end));
export const enter = (frame: number, start: number): CSSProperties => {
  const t = Easing.bezier(.2, .7, .2, 1)(progress(frame, start, start + 12));
  return {opacity: t, transform: `translateY(${20 * (1 - t)}px)`};
};
export const Packet = ({x, y, receipt = false, opacity = 1}: {x: number; y: number; receipt?: boolean; opacity?: number}) => <svg width={56} height={40} viewBox="0 0 56 40" style={{position: 'absolute', left: x, top: y, opacity}}>
  <rect x={1} y={1} width={54} height={38} rx={5} fill={p.amber} stroke={p.amberInk} strokeWidth={2}/>
  <path d={receipt ? 'M17 21 L25 29 L40 12' : 'M4 6 L28 24 L52 6'} fill="none" stroke={receipt ? p.ink : p.amberInk} strokeWidth={receipt ? 3 : 2} strokeLinecap="round" strokeLinejoin="round"/>
</svg>;
export const Route = ({x1, x2, y, amount = 0, reverse = false, dashed = false}: {x1: number; x2: number; y: number; amount?: number; reverse?: boolean; dashed?: boolean}) => <svg width={1920} height={1080} style={{position: 'absolute', inset: 0, pointerEvents: 'none'}}>
  <path d={`M${x1} ${y}H${x2}`} stroke={p.rule} strokeWidth={1} strokeDasharray={dashed ? '4 4' : undefined}/>
  <path d={reverse ? `M${x2} ${y}H${x2 - (x2 - x1) * amount}` : `M${x1} ${y}H${x1 + (x2 - x1) * amount}`} stroke={p.amber} strokeWidth={4}/>
</svg>;
export const DispatchCard = ({x, y, width, height, product, handle, provider, children, oneLine = false, style}: {x: number; y: number; width: number; height: number; product: string; handle: string; provider: 'claude' | 'codex' | 'tui'; children: ReactNode; oneLine?: boolean; style?: CSSProperties}) => <section style={{position: 'absolute', left: x, top: y, width, height, boxSizing: 'border-box', background: p.panel, border: `1px solid ${p.lineDark}`, borderRadius: 8, overflow: 'hidden', ...style}}>
  <header style={{height: 56, boxSizing: 'border-box', padding: '0 28px 0 32px', background: p.header, borderBottom: `1px solid ${p.lineDark}`, display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontFamily: type.mono.fontFamily}}>
    <div style={{display: 'flex', alignItems: 'center', gap: 14, fontSize: 22}}><span style={{width: 10, height: 10, borderRadius: '50%', background: provider === 'claude' ? p.ember : provider === 'codex' ? p.paper : p.amber}}/><span style={{fontWeight: 500, letterSpacing: '.08em', color: p.mutedDark}}>{product}</span><span style={{color: p.dimDark}}>·</span><span style={{color: p.paper}}>{handle}</span></div>
    <span style={{color: p.dimDark, fontSize: 18, letterSpacing: '.12em'}}>RECORDED</span>
  </header>
  <div style={{...type.mono, height: height - 56, boxSizing: 'border-box', fontSize: oneLine ? 32 : 28, lineHeight: oneLine ? '46px' : '40px', padding: oneLine ? '32px 40px' : '28px 40px 32px', color: p.paper, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere'}}><div style={{height: '100%', overflow: 'hidden', margin: '0 -40px', padding: '0 40px'}}>{children}</div></div>
</section>;
export const Mask = ({characters}: {characters: number}) => <span aria-label="redacted" style={{display: 'inline-block', width: `${characters}ch`, height: '.75em', borderRadius: 2, background: `repeating-linear-gradient(135deg, var(--mask-stripe, ${p.lineDark}) 0 3px, transparent 3px 7px)`}}/>;
