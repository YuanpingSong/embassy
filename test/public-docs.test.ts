import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

/**
 * Terms that named the deleted static and live dashboards. emb-100 removed both
 * surfaces; nothing shipped in English may advertise them again. This is the
 * inverse of the dashboard-contract test emb-100 deleted: that test proved the
 * documented dashboard contract was current, this one proves there is no
 * dashboard contract left to document.
 */
const FORBIDDEN = [
  "dashboard --live",
  "refresh-dashboard",
  "gateway-dashboard",
  "41961",
  "X-Embassy-Request",
  "remove_codex_registration",
] as const;

/**
 * zh-CN documents still describe the removed surfaces. emb-102 is the slice that
 * deletes localization outright, so they are excluded here rather than edited.
 * CHANGELOG.md, .github/release-notes/*, and docs/DECLINED.md are history: they
 * must keep naming what past releases shipped and what we refused to build.
 */
const isExcluded = (relativePath: string): boolean =>
  relativePath.includes(".zh-CN.") ||
  relativePath.includes("/zh-CN/") ||
  relativePath === "CHANGELOG.md" ||
  relativePath === "docs/DECLINED.md" ||
  relativePath.startsWith(".github/release-notes/");

async function walk(relativeDirectory: string): Promise<string[]> {
  const entries = await readdir(path.join(repoRoot, relativeDirectory), {
    withFileTypes: true,
  });
  const found: string[] = [];
  for (const entry of entries) {
    const relativePath = path.posix.join(relativeDirectory, entry.name);
    if (entry.isDirectory()) found.push(...(await walk(relativePath)));
    else found.push(relativePath);
  }
  return found;
}

async function shippedEnglishDocuments(): Promise<string[]> {
  const docs = (await walk("docs")).filter((file) => file.endsWith(".md"));
  const skill = await walk("skills/embassy-peer");
  return [
    "README.md",
    "SECURITY.md",
    "CONTRIBUTING.md",
    "AGENTS.md",
    "site/index.html",
    ...docs,
    ...skill,
  ]
    .filter((file) => !isExcluded(file))
    .sort();
}

test("no shipped English document advertises the deleted dashboards", async () => {
  const files = await shippedEnglishDocuments();
  // Guard the guard: an empty or truncated file list would pass vacuously.
  assert.ok(files.includes("README.md"));
  assert.ok(files.includes("SECURITY.md"));
  assert.ok(files.includes("docs/GATEWAY-ARCHITECTURE.md"));
  assert.ok(files.includes("skills/embassy-peer/SKILL.md"));
  assert.ok(files.length >= 8, `only ${String(files.length)} documents scanned`);
  assert.equal(files.some((file) => isExcluded(file)), false);

  const offenders: string[] = [];
  for (const file of files) {
    const text = await readFile(path.join(repoRoot, file), "utf8");
    for (const term of FORBIDDEN) {
      if (text.includes(term)) offenders.push(`${file}: ${term}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test("public docs disclose that the status snapshot carries retained bodies", async () => {
  const [readme, architecture] = await Promise.all([
    readFile(path.join(repoRoot, "README.md"), "utf8"),
    readFile(path.join(repoRoot, "docs", "GATEWAY-ARCHITECTURE.md"), "utf8"),
  ]);
  // `embassy status` prints the public snapshot, and store.ts projects `body`
  // onto every message event, so no shipped doc may call that output
  // metadata-only.
  assert.doesNotMatch(readme, /metadata-only status snapshot/i);
  assert.match(readme, /status snapshot that includes retained message bodies/);
  assert.match(
    readme,
    /`embassy status` shows retained bodies; treat its output as sensitive as the messages themselves\./,
  );
  assert.match(architecture, /pane also carries the bounded ledger's retained message bodies/);
});
