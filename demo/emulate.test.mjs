import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import test from "node:test";

const helper = fileURLToPath(new URL("./emulate.mjs", import.meta.url));

const run = (requests) => {
  const result = spawnSync(process.execPath, [helper], {
    encoding: "utf8",
    input: `${requests.map((request) => JSON.stringify(request)).join("\n")}\n`,
    timeout: 5_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.signal, null);
  assert.equal(result.stderr, "");
  const lines = result.stdout.trim().split("\n").filter(Boolean);
  return {messages: lines.map((line) => JSON.parse(line)), stdout: result.stdout};
};

const data = (value) => ({data: Buffer.from(value).toString("base64")});
const rowText = (snapshot, row = 0) => snapshot.rows[row].map((entry) => entry.text).join("");

test("ANSI cursor addressing overwrites cells and tracks cursor visibility", () => {
  const hidden = run([
    data("hello world\u001b[1;7Hthere\u001b[2;5Hnext\u001b[?25l"),
    {snapshot: true},
  ]).messages.at(-1);
  assert.equal(rowText(hidden), "hello there");
  assert.equal(rowText(hidden, 1), "    next");
  assert.deepEqual(hidden.cursor, {row: 1, column: 8, visible: false});

  const shown = run([data("\u001b[?25l\u001b[?25h"), {snapshot: true}]).messages.at(-1);
  assert.equal(shown.cursor.visible, true);
});

test("Unicode survives writes split inside UTF-8 sequences and wide continuations are skipped", () => {
  const encoded = Buffer.from("A界🙂B");
  const {messages} = run([
    {data: encoded.subarray(0, 3).toString("base64")},
    {data: encoded.subarray(3, 6).toString("base64")},
    {data: encoded.subarray(6).toString("base64")},
    {snapshot: true},
  ]);
  const snapshot = messages.at(-1);
  assert.equal(rowText(snapshot), "A界🙂B");
  // xterm's default Unicode provider treats CJK as width 2 and this emoji as width 1.
  assert.equal(snapshot.cursor.column, 5);
});

test("16-color, 256-color, and RGB attributes become structured runs", () => {
  const {messages} = run([
    data("\u001b[31mR\u001b[38;5;196mP\u001b[48;2;1;2;3mT\u001b[0m"),
    {snapshot: true},
  ]);
  assert.deepEqual(messages.at(-1).rows[0], [
    {fg: "red", text: "R"},
    {fg: "ff0000", text: "P"},
    {fg: "ff0000", bg: "010203", text: "T"},
  ]);
});

test("terminal queries and writes emit JSON envelopes without raw terminal logs", () => {
  const sentinel = "RAW_TRANSCRIPT_SENTINEL";
  const {messages, stdout} = run([data(`${sentinel}\u001b[6n`)]);
  assert.deepEqual(messages, [
    {response: Buffer.from("\u001b[1;24R").toString("base64")},
    {ok: true},
  ]);
  assert.equal(stdout.includes(sentinel), false);
  for (const line of stdout.trim().split("\n")) assert.doesNotThrow(() => JSON.parse(line));
});
