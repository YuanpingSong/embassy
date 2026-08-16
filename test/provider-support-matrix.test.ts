import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MATRIX_NAME = "provider-support-matrix.json";
const MATRIX_PATH = path.join(ROOT, "support", MATRIX_NAME);

type MatrixEntry = Readonly<{
  provider: unknown;
  transport: unknown;
  exactArtifact: unknown;
  protocol: unknown;
  capabilities: unknown;
  stopFidelity: unknown;
  limitations: unknown;
  testDate: unknown;
}>;

function isNonemptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isNonemptyStringArray(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(isNonemptyString)
  );
}

async function sourceFiles(directory: string): Promise<readonly string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) return await sourceFiles(target);
      return entry.isFile() && target.endsWith(".ts") ? [target] : [];
    }),
  );
  return nested.flat();
}

test("release-owned provider support matrix is closed, explicit, and parseable", async () => {
  const matrix = JSON.parse(await readFile(MATRIX_PATH, "utf8")) as Record<
    string,
    unknown
  >;
  assert.deepEqual(Object.keys(matrix).sort(), [
    "entries",
    "release",
    "schemaVersion",
  ]);
  assert.equal(matrix.schemaVersion, 1);
  assert.equal(matrix.release, "v1.7-preflight");
  assert.ok(Array.isArray(matrix.entries));

  const providers = new Set<string>();
  for (const value of matrix.entries) {
    assert.equal(typeof value, "object");
    assert.notEqual(value, null);
    const entry = value as MatrixEntry;
    assert.deepEqual(Object.keys(value as object).sort(), [
      "capabilities",
      "exactArtifact",
      "limitations",
      "protocol",
      "provider",
      "stopFidelity",
      "testDate",
      "transport",
    ]);
    assert.ok(isNonemptyString(entry.provider));
    assert.equal(providers.has(entry.provider), false);
    providers.add(entry.provider);
    assert.ok(isNonemptyString(entry.transport));
    assert.ok(isNonemptyString(entry.exactArtifact));
    assert.ok(isNonemptyString(entry.protocol));
    assert.ok(isNonemptyStringArray(entry.capabilities));
    assert.ok(isNonemptyString(entry.stopFidelity));
    assert.ok(isNonemptyStringArray(entry.limitations));
    assert.ok(isNonemptyString(entry.testDate));
    assert.match(entry.testDate, /^\d{4}-\d{2}-\d{2}$/u);
  }
  assert.deepEqual([...providers].sort(), [
    "claude",
    "codex",
    "deepseek",
    "grok",
  ]);
});

test("runtime source never imports the release-owned support matrix", async () => {
  for (const source of await sourceFiles(path.join(ROOT, "src"))) {
    assert.equal(
      (await readFile(source, "utf8")).includes(MATRIX_NAME),
      false,
      source,
    );
  }
});
