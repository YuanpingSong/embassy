// A single overlay owns both sides of each cut; scene fades never touch it.
export function carryPacket(frame: number, ease: (t: number) => number = t => t) {
  const progress = (a: number, b: number) => Math.max(0, Math.min(1, (frame-a)/(b-a)));
  if (frame >= 226 && frame < 300) {
    return {x: frame < 266 ? 92 + 780*ease(progress(230,266)) : 872 + 1048*progress(266,299), y:660, opacity:progress(226,230)};
  }
  if (frame >= 300 && frame < 503) {
    return {x:-60 + 152*ease(progress(300,318)), y:621, opacity:1-progress(496,502)};
  }
  if (frame >= 556 && frame < 660) {
    return {x:frame < 612 ? 1808-780*ease(progress(560,612)) : 1028-1088*progress(612,659), y:660, opacity:progress(556,560)};
  }
  if (frame >= 660 && frame < 815) {
    return {x:1980-208*ease(progress(660,678)), y:621, opacity:1-progress(806,814)};
  }
  return null;
}
