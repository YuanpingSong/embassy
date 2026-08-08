import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const checkerPath = path.join(repoRoot, "scripts", "check-npm-package.mjs");

function runChecker(args: readonly string[]) {
  return spawnSync(process.execPath, [checkerPath, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
  });
}

function expectedPaths(): string[] {
  const result = runChecker(["--print-expected"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  const parsed: unknown = JSON.parse(result.stdout);
  assert.ok(Array.isArray(parsed));
  assert.ok(parsed.every((value) => typeof value === "string"));
  return parsed as string[];
}

test("exact npm manifest names every runtime artifact and canonical public asset", async () => {
  const expected = expectedPaths();
  assert.deepEqual(expected, [...new Set(expected)].sort());

  for (const packagePath of [
    "assets/mark-seal.svg",
    "assets/mark.svg",
    "assets/social-preview.png",
    "docs/DESIGN.md",
    "docs/GATEWAY-ARCHITECTURE.md",
    "dist/src/gateway/codex-registration-succession.js",
    "dist/src/gateway/delivery-machine.js",
    "dist/src/gateway/live-dashboard.js",
  ]) {
    assert.ok(expected.includes(packagePath), packagePath);
  }
  assert.ok(!expected.includes("assets/social-preview-arcs-fable.png"));

  const sourceModules = (await readdir(path.join(repoRoot, "src", "gateway")))
    .filter((filename) => filename.endsWith(".ts"))
    .map((filename) => filename.slice(0, -3))
    .sort();
  const manifestModules = expected
    .filter(
      (packagePath) =>
        packagePath.startsWith("dist/src/gateway/") &&
        packagePath.endsWith(".js") &&
        !packagePath.endsWith(".js.map"),
    )
    .map((packagePath) => path.basename(packagePath, ".js"))
    .sort();
  assert.deepEqual(manifestModules, sourceModules);

  for (const javascriptPath of expected.filter(
    (packagePath) =>
      packagePath.startsWith("dist/src/") &&
      packagePath.endsWith(".js") &&
      !packagePath.endsWith(".js.map"),
  )) {
    const stem = javascriptPath.slice(0, -3);
    assert.ok(expected.includes(`${stem}.d.ts`), `${stem}.d.ts`);
    assert.ok(expected.includes(`${stem}.js.map`), `${stem}.js.map`);
  }
});

test("package checker rejects missing and regex-shaped extra files", async (t) => {
  const expected = expectedPaths();
  const packageJson = JSON.parse(
    await readFile(path.join(repoRoot, "package.json"), "utf8"),
  ) as { name: string; version: string };
  const filename = `${packageJson.name}-${packageJson.version}.tgz`;
  const report = {
    name: packageJson.name,
    version: packageJson.version,
    filename,
    files: expected.map((packagePath) => ({ path: packagePath })),
  };
  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), "embassy-manifest-test-"),
  );
  t.after(async () => rm(temporaryRoot, { recursive: true, force: true }));
  const reportPath = path.join(temporaryRoot, "package-report.json");

  await writeFile(reportPath, JSON.stringify([report]), "utf8");
  const accepted = runChecker(["--report", reportPath]);
  assert.equal(accepted.status, 0, accepted.stderr);

  await writeFile(
    reportPath,
    JSON.stringify([
      {
        ...report,
        files: [
          ...report.files,
          { path: "dist/src/gateway/surprise-runtime.js" },
        ],
      },
    ]),
    "utf8",
  );
  const unexpected = runChecker(["--report", reportPath]);
  assert.equal(unexpected.status, 1);
  assert.match(unexpected.stderr, /unexpected: .*surprise-runtime\.js/);

  await writeFile(
    reportPath,
    JSON.stringify([
      {
        ...report,
        files: report.files.filter(
          ({ path: packagePath }) =>
            packagePath !==
            "dist/src/gateway/codex-registration-succession.js",
        ),
      },
    ]),
    "utf8",
  );
  const missing = runChecker(["--report", reportPath]);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /missing: .*codex-registration-succession\.js/);
});
