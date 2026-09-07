# Embassy demo video

This isolated Remotion project turns sanitized, real terminal captures into the
Embassy demo. It is development-only and is intentionally absent from the root
npm package allowlist.

## Capture contract

Put these five files in `public/captures/`:

- `tui-overview.json`
- `claude-send.json`
- `codex-wake.json`
- `claude-reply.json`
- `tui-settled.json`

Each file is a complete terminal recording:

```json
{
  "version": 1,
  "columns": 90,
  "rows": 24,
  "frames": [
    {
      "timeMs": 0,
      "rows": [
        [{"text": "$ ", "fg": "brightBlack"}, {"text": "embassy tui", "bold": true}]
      ],
      "cursor": {"row": 0, "column": 13, "visible": true}
    }
  ]
}
```

`frames` are full snapshots (not deltas) with monotonic millisecond timestamps.
Runs may use lowercase ANSI color names, `default`, six-digit RGB values (with
or without `#`), and `bold`, `dim`, `inverse`, or `underline`.
Sanitize before saving: public aliases and delivery receipt tokens are allowed;
provider credentials, peer tokens, auth material, native IDs, and personal paths
are not.

Missing captures render an explicit `REAL CAPTURE REQUIRED` card. The project
contains no fabricated terminal transcript.

`emulate.mjs` is the recorder's terminal backend. It reads one JSON object per
line on stdin: `{"data":"<base64>"}` feeds PTY output into a fixed 90×24
xterm parser, and `{"snapshot":true}` returns the current structured rows and
cursor. Terminal query replies are emitted as `{"response":"<base64>"}` for
the recorder to write back to the PTY. Standard output contains JSON only; the
helper does not write terminal bytes or transcripts to disk.

## Work locally

Requires Node 22 or newer.

```sh
npm install
npm run check
npm run studio
```

The recorder requires Python 3 (standard library only). It owns a 90×24 PTY;
raw terminal bytes remain in memory and redaction runs before snapshots are
written. Recording real agents requires explicit operator authorization.

```sh
python3 record.py --output public/captures/take.json --cwd /path/to/demo -- embassy tui
```

Send JSON lines to its stdin: `{"input":"2"}`, `{"snapshot":true}`,
`{"save":true}`, `{"stop":true}`. Stopping closes only the process it started.
Use `--fresh-principal` when starting a scratch agent, not a read-only TUI.
The recorder never changes provider configuration or grants permissions.
Normal one-shot permission dialogs are approved by the recording operator.

`node edit.mjs <edit-plan.json> public/captures` selects full recorded frames,
trims or retimes waits, and optionally crops top/bottom terminal rows. It records
source hashes and exact edit intervals in `provenance.json`; it cannot invent
terminal text. Source captures, edit lists, and rendered media are local artifacts,
not part of the published npm package. Tests: `npm run check` and
`python3 -m unittest test_record.py`.

Render the 1920×1080, 30 fps, 55-second master and a separate 12-second
README teaser GIF (90 sampled frames to stay within the 8 MB budget):

```sh
npm run render
npm run render:gif
```

Outputs go to the ignored `out/` directory. Use the Remotion still command for
keyframes, for example:

```sh
npx remotion still src/index.ts EmbassyDemo out/keyframe-overview.png --frame=120
```
