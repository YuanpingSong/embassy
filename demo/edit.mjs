import {createHash} from "node:crypto";
import {mkdir, readFile, rename, writeFile} from "node:fs/promises";
import {dirname, isAbsolute, resolve, sep} from "node:path";
import {fileURLToPath} from "node:url";

const OUTPUTS = ["tui-overview", "claude-send", "codex-wake", "claude-reply", "tui-settled"];
const AGENT_VIEWS = ["v2-claude-agents", "v2-codex-agents", "v2-tui-overview", "v2-ssh", "v2-codex-idle"];

const fail = (message) => {
  throw new Error(message);
};

const integer = (value, label, minimum = 0) => {
  if (!Number.isInteger(value) || value < minimum) fail(`${label} must be an integer >= ${minimum}`);
  return value;
};

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

export const redactEndpointAliases = (frame, host) => {
  if (!frame.rows[0].map((run) => run.text).join("").includes(`[${host} ·`)) return frame;
  return {...frame, rows: frame.rows.map((row) => {
    const text = row.map((run) => run.text).join("");
    const provider = text.slice(41, 47).trim();
    if (provider !== "codex" && provider !== "claude") return row;
    // Frozen 90-column TUI footage: Endpoint occupies columns 14 through 40.
    const masked = text.slice(0, 14) + `${provider}-…@${host}`.padEnd(27) + text.slice(41);
    let offset = 0;
    return row.map((run) => {
      const result = {...run, text: masked.slice(offset, offset + run.text.length)};
      offset += run.text.length;
      return result;
    });
  })};
};

const validateCapture = (value, label) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  if (value.version !== 1) fail(`${label}.version must be 1`);
  integer(value.columns, `${label}.columns`, 1);
  integer(value.rows, `${label}.rows`, 1);
  if (!Array.isArray(value.frames) || value.frames.length === 0) fail(`${label}.frames must not be empty`);
  let previous = -1;
  value.frames.forEach((frame, frameIndex) => {
    if (!frame || typeof frame !== "object" || Array.isArray(frame)) fail(`${label}.frames[${frameIndex}] must be an object`);
    if (typeof frame.timeMs !== "number" || !Number.isFinite(frame.timeMs) || frame.timeMs < previous) {
      fail(`${label}.frames timestamps must be finite and monotonic`);
    }
    previous = frame.timeMs;
    if (!Array.isArray(frame.rows) || frame.rows.length !== value.rows) {
      fail(`${label}.frames[${frameIndex}].rows must match capture.rows`);
    }
    for (const row of frame.rows) {
      if (!Array.isArray(row) || row.some((run) => !run || typeof run !== "object" || typeof run.text !== "string")) {
        fail(`${label}.frames[${frameIndex}] has an invalid row`);
      }
    }
  });
  return value;
};

const containedPath = (base, relative, label) => {
  if (typeof relative !== "string" || !relative || isAbsolute(relative)) fail(`${label} must be a relative path`);
  const path = resolve(base, relative);
  if (path !== base && !path.startsWith(`${base}${sep}`)) fail(`${label} must stay inside the plan directory`);
  return path;
};

const selectFrames = (capture, segment, label) => {
  const startMs = integer(segment.startMs, `${label}.startMs`);
  const endMs = integer(segment.endMs, `${label}.endMs`);
  if (endMs <= startMs) fail(`${label}.endMs must be greater than startMs`);
  const outputDurationMs = segment.outputDurationMs === undefined
    ? endMs - startMs
    : integer(segment.outputDurationMs, `${label}.outputDurationMs`, 1);
  const anchor = capture.frames.findLast((frame) => frame.timeMs <= startMs);
  if (!anchor) fail(`${label} has no source frame at or before startMs`);
  const selected = [anchor, ...capture.frames.filter((frame) => frame.timeMs > startMs && frame.timeMs <= endMs)];
  return {
    frames: selected.map((frame, index) => ({
      ...structuredClone(frame),
      timeMs: index === 0
        ? 0
        : Math.round(((frame.timeMs - startMs) / (endMs - startMs)) * outputDurationMs),
    })),
    startMs,
    endMs,
    outputDurationMs,
    anchorTimeMs: anchor.timeMs,
  };
};

const atomicWrite = async (path, contents) => {
  const temporary = `${path}.tmp`;
  await writeFile(temporary, contents, {encoding: "utf8"});
  await rename(temporary, path);
};

export const editCaptures = async (planPath, outputDirectory) => {
  const planBytes = await readFile(planPath);
  const plan = JSON.parse(planBytes.toString("utf8"));
  if (!plan || typeof plan !== "object" || plan.version !== 1 || !plan.outputs || typeof plan.outputs !== "object") {
    fail("edit plan must use schema version 1 and define outputs");
  }
  const names = Object.keys(plan.outputs).sort();
  if (OUTPUTS.some((name) => !names.includes(name)) || names.some((name) => ![...OUTPUTS, ...AGENT_VIEWS].includes(name))) {
    fail(`edit plan must define exactly the five exchange outputs, with optional native agent views`);
  }

  const planDirectory = dirname(resolve(planPath));
  const sourceCache = new Map();
  const products = new Map();
  const provenance = {version: 1, planSha256: sha256(planBytes), outputs: {}};

  for (const name of names) {
    const specification = plan.outputs[name];
    if (!specification || typeof specification !== "object" || !Array.isArray(specification.segments) || specification.segments.length === 0) {
      fail(`${name}.segments must not be empty`);
    }
    let maximumRows = 0;
    let columns;
    let sourceRows;
    let outputOffset = 0;
    const frames = [];
    const segmentProofs = [];

    for (const [index, segment] of specification.segments.entries()) {
      if (!segment || typeof segment !== "object") fail(`${name}.segments[${index}] must be an object`);
      const crop = segment.crop ?? specification.crop;
      const cropTop = integer(crop?.top ?? 0, `${name}.crop.top`);
      const cropBottom = integer(crop?.bottom ?? 0, `${name}.crop.bottom`);
      const sourcePath = containedPath(planDirectory, segment.source, `${name}.segments[${index}].source`);
      let source = sourceCache.get(sourcePath);
      if (!source) {
        const bytes = await readFile(sourcePath);
        source = {bytes, capture: validateCapture(JSON.parse(bytes.toString("utf8")), segment.source)};
        sourceCache.set(sourcePath, source);
      }
      if (columns === undefined) {
        columns = source.capture.columns;
        sourceRows = source.capture.rows;
      } else if (columns !== source.capture.columns || sourceRows !== source.capture.rows) {
        fail(`${name} source captures must have identical dimensions`);
      }
      if (cropTop + cropBottom >= source.capture.rows) fail(`${name} crop removes every row`);
      maximumRows = Math.max(maximumRows, source.capture.rows - cropTop - cropBottom);
      const selected = selectFrames(source.capture, segment, `${name}.segments[${index}]`);
      for (const recordedFrame of selected.frames) {
        const frame = specification.redactEndpointAliasesForHost
          ? redactEndpointAliases(recordedFrame, specification.redactEndpointAliasesForHost) : recordedFrame;
        const outputRows = source.capture.rows - cropTop - cropBottom;
        const cursor = frame.cursor ? {
          ...frame.cursor,
          row: Math.max(0, Math.min(outputRows - 1, frame.cursor.row - cropTop)),
          visible: frame.cursor.visible && frame.cursor.row >= cropTop && frame.cursor.row < source.capture.rows - cropBottom,
        } : undefined;
        frames.push({
          ...frame,
          timeMs: outputOffset + frame.timeMs,
          rows: frame.rows.slice(cropTop, source.capture.rows - cropBottom),
          ...(cursor ? {cursor} : {}),
        });
      }
      segmentProofs.push({
        source: segment.source,
        sourceSha256: sha256(source.bytes),
        startMs: selected.startMs,
        endMs: selected.endMs,
        anchorTimeMs: selected.anchorTimeMs,
        outputStartMs: outputOffset,
        outputDurationMs: selected.outputDurationMs,
        frameCount: selected.frames.length,
        crop: {top: cropTop, bottom: cropBottom},
      });
      outputOffset += selected.outputDurationMs;
    }

    const capture = {version: 1, columns, rows: maximumRows, frames};
    const contents = `${JSON.stringify(capture)}\n`;
    products.set(`${name}.json`, contents);
    provenance.outputs[name] = {
      sha256: sha256(contents),
      columns: capture.columns,
      rows: capture.rows,
      durationMs: outputOffset,
      ...(specification.redactEndpointAliasesForHost ? {redactEndpointAliasesForHost: specification.redactEndpointAliasesForHost} : {}),
      segments: segmentProofs,
    };
  }

  await mkdir(outputDirectory, {recursive: true});
  for (const [name, contents] of products) await atomicWrite(resolve(outputDirectory, name), contents);
  await atomicWrite(resolve(outputDirectory, "provenance.json"), `${JSON.stringify(provenance, null, 2)}\n`);
  return provenance;
};

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  const [, , planPath, outputDirectory] = process.argv;
  if (!planPath || !outputDirectory) {
    process.stderr.write("usage: node edit.mjs <plan.json> <output-directory>\n");
    process.exitCode = 2;
  } else {
    editCaptures(resolve(planPath), resolve(outputDirectory))
      .then((proof) => process.stdout.write(`${JSON.stringify({ok: true, outputs: Object.keys(proof.outputs).length})}\n`))
      .catch((error) => {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
      });
  }
}
