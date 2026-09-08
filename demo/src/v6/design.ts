// Demo v6: approved light dispatch-card design. Canvas pixels, 30 fps.
export const palette = {
  ground: '#F6F1E9', card: '#FFFDFA', line: '#D6CCBF', rule: '#C9BFB2',
  ink: '#15120F', muted: '#524B46', dim: '#918880', amber: '#F4A259',
  amberInk: '#70390A', emberInk: '#96421F', panel: '#1A171A',
  header: '#211D21', lineDark: '#2F2A2F', band: '#2C231D',
  paper: '#F1ECE3', mutedDark: '#A79F98', dimDark: '#6B6367',
  ember: '#D0704F', moss: '#9CC08E',
} as const;

export const scenes = [
  {start: 0, end: 150, eyebrow: 'CLAUDE CODE ↔ CODEX CLI', headline: 'Let your agents talk.', caption: 'By name. On your machines.'},
  {start: 150, end: 300, eyebrow: 'ONE COMMAND FROM CLAUDE', headline: 'Send by name.', caption: 'No session IDs to copy.'},
  {start: 300, end: 510, eyebrow: 'IT ARRIVES IN CODEX', headline: 'The Codex agent wakes up.', caption: 'Delivered straight into the Codex session. Nothing polls.'},
  {start: 510, end: 660, eyebrow: 'CODEX REPLIES', headline: 'Codex answers in the same conversation.', caption: 'The reply can only go back to whoever asked.'},
  {start: 660, end: 840, eyebrow: 'THE LOOP CLOSES', headline: 'Back in Claude.', caption: 'Reply received.'},
  {start: 840, end: 1020, eyebrow: 'MORE THAN ONE MAC', headline: 'Across Macs. Over SSH.', caption: 'The message crosses over SSH.'},
  {start: 1020, end: 1200, eyebrow: 'FOLLOW THE OUTCOME', headline: 'Receipts, not guesswork.', caption: 'Delivered means it arrived, not that it was read.'},
] as const;

export const type = {
  headline: {fontFamily: 'Newsreader', fontSize: 88, lineHeight: '96px', fontWeight: 500, letterSpacing: '-0.015em'},
  mono: {fontFamily: 'IBM Plex Mono', fontSize: 28, lineHeight: '40px'},
  caption: {fontFamily: 'IBM Plex Sans', fontSize: 36, lineHeight: '48px'},
} as const;
