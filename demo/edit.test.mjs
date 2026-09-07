import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdtemp, readFile, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";
import {editCaptures} from "./edit.mjs";

const names = ["tui-overview", "claude-send", "codex-wake", "claude-reply", "tui-settled"];
const hash = (value) => createHash("sha256").update(value).digest("hex");
const row = (text) => [{text}];

test("edit list selects only actual frames, retimes intervals, crops rows, and records provenance", async () => {
  const directory = await mkdtemp(join(tmpdir(), "embassy-edit-"));
  const source = {
    version: 1,
    columns: 90,
    rows: 2,
    frames: [0, 100, 200, 300].map((timeMs) => ({
      timeMs,
      rows: [row(`top-${timeMs}`), row(`body-${timeMs}`)],
      cursor: {row: 1, column: 4, visible: true},
    })),
  };
  const sourceBytes = `${JSON.stringify(source)}\n`;
  await writeFile(join(directory, "source.json"), sourceBytes);
  const specification = {
    crop: {top: 1, bottom: 0},
    segments: [
      {source: "source.json", startMs: 50, endMs: 200, outputDurationMs: 300},
      {source: "source.json", startMs: 250, endMs: 300, outputDurationMs: 100},
    ],
  };
  const plan = {version: 1, outputs: Object.fromEntries(names.map((name) => [name, specification]))};
  const planPath = join(directory, "plan.json");
  const output = join(directory, "out");
  await writeFile(planPath, `${JSON.stringify(plan)}\n`);

  const provenance = await editCaptures(planPath, output);
  const captureBytes = await readFile(join(output, "tui-overview.json"), "utf8");
  const capture = JSON.parse(captureBytes);
  assert.equal(capture.columns, 90);
  assert.equal(capture.rows, 1);
  assert.deepEqual(capture.frames.map((frame) => frame.timeMs), [0, 100, 300, 300, 400]);
  assert.deepEqual(capture.frames.map((frame) => frame.rows[0][0].text), [
    "body-0", "body-100", "body-200", "body-200", "body-300",
  ]);
  assert.deepEqual(capture.frames[0].cursor, {row: 0, column: 4, visible: true});
  assert.equal(new Set(capture.frames.flatMap((frame) => frame.rows.flatMap((line) => line.map((run) => run.text)))).has("invented"), false);
  assert.equal(provenance.outputs["tui-overview"].sha256, hash(captureBytes));
  assert.equal(provenance.outputs["tui-overview"].segments[0].sourceSha256, hash(sourceBytes));
  assert.deepEqual(provenance.outputs["tui-overview"].segments.map((segment) => segment.anchorTimeMs), [0, 200]);
  assert.equal(JSON.parse(await readFile(join(output, "provenance.json"), "utf8")).outputs["tui-overview"].durationMs, 400);
});

test("edit list requires all five outputs and keeps sources inside the plan directory", async () => {
  const directory = await mkdtemp(join(tmpdir(), "embassy-edit-invalid-"));
  const output = join(directory, "out");
  const missing = join(directory, "missing.json");
  await writeFile(missing, JSON.stringify({version: 1, outputs: {}}));
  await assert.rejects(editCaptures(missing, output), /must define exactly/u);

  const escape = {
    version: 1,
    outputs: Object.fromEntries(names.map((name) => [name, {
      segments: [{source: "../source.json", startMs: 0, endMs: 1}],
    }])),
  };
  const escapePath = join(directory, "escape.json");
  await writeFile(escapePath, JSON.stringify(escape));
  await assert.rejects(editCaptures(escapePath, output), /must stay inside/u);
});
