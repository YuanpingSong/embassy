// A single overlay owns both sides of each cut; scene fades never touch it.
export function carryPacket(frame: number, ease: (t: number) => number = t => t) {
  const progress = (a: number, b: number) => Math.max(0, Math.min(1, (frame-a)/(b-a)));
  // Hermite exit: leave the node at rest, meet the receiving cubic at 20 px/f.
  const exit = (from: number, to: number, start: number, end: number, speed: number) => {
    const t = progress(start,end);
    return from + (to-from)*(3*t*t-2*t*t*t) + speed*(end-start)*(t*t*t-t*t);
  };
  const receive = (from: number, to: number, start: number) => from + (to-from)*(1-(1-progress(start,start+18))**3);
  if (frame >= 226 && frame < 300) {
    return {x: frame < 266 ? 92 + 780*ease(progress(230,266)) : exit(872,1892,266,299,20), y:660, opacity:progress(226,230)};
  }
  if (frame >= 300 && frame < 503) {
    return {x:receive(-28,92,300), y:461, opacity:1-progress(496,502)};
  }
  if (frame >= 556 && frame < 660) {
    return {x:frame < 612 ? 1808-780*ease(progress(560,612)) : exit(1028,-28,612,659,-20), y:660, opacity:progress(556,560)};
  }
  if (frame >= 660 && frame < 815) {
    return {x:receive(1892,1772,660), y:621, opacity:1-progress(806,814)};
  }
  return null;
}
