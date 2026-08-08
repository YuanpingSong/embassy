import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

async function readPublicFile(relativePath: string): Promise<string> {
  return await readFile(path.join(repoRoot, relativePath), "utf8");
}

function headingLevels(markdown: string): number[] {
  return [...markdown.matchAll(/^(#{1,6})\s+\S/gm)].map(
    (match) => match[1]?.length ?? 0,
  );
}

function fencedBlocks(
  markdown: string,
): ReadonlyArray<Readonly<{ language: string; body: string }>> {
  return [...markdown.matchAll(/^```([^\n]*)\n([\s\S]*?)^```\s*$/gm)].map(
    (match) => ({
      language: match[1] ?? "",
      body: match[2] ?? "",
    }),
  );
}

function captures(text: string, pattern: RegExp): string[] {
  return [...text.matchAll(pattern)].map((match) => match[1] ?? "");
}

test("Simplified Chinese README preserves the complete executable contract", async () => {
  const [english, chinese] = await Promise.all([
    readPublicFile("README.md"),
    readPublicFile("README.zh-CN.md"),
  ]);

  assert.match(
    english,
    /^\[English\]\(README\.md\) · \[简体中文\]\(README\.zh-CN\.md\)/,
  );
  assert.match(chinese, /^\[English\]\(README\.md\) · 简体中文/);
  assert.deepEqual(headingLevels(chinese), headingLevels(english));

  const englishBlocks = fencedBlocks(english);
  const chineseBlocks = fencedBlocks(chinese);
  assert.deepEqual(
    chineseBlocks.map(({ language }) => language),
    englishBlocks.map(({ language }) => language),
  );
  for (const [index, englishBlock] of englishBlocks.entries()) {
    if (englishBlock?.language === "text") continue;
    assert.equal(chineseBlocks[index]?.body, englishBlock?.body);
  }

  for (const token of [
    "embassy register-codex --alias codex-successor@this-mac --succeeds codex-reviewer@this-mac",
    "embassy dashboard --live",
    "embassy delivery-status --token dlv_<token>",
    "gateway-dashboard.html",
    "gateway-dashboard.zh-CN.html",
    "dlv_",
    "unconfirmed",
    "ambiguous",
    "X-Embassy-Request",
  ]) {
    assert.ok(chinese.includes(token), token);
  }

  assert.equal(chinese.includes("Execution error"), false);
  assert.equal(chinese.includes("```markdown"), false);
});

test("marketing pages preserve structure, protocol tokens, and reciprocal locale links", async () => {
  const [english, chinese] = await Promise.all([
    readPublicFile("site/index.html"),
    readPublicFile("site/zh-CN/index.html"),
  ]);

  assert.match(english, /<html lang="en">/);
  assert.match(chinese, /<html lang=["']zh-CN["']>/);
  assert.match(
    english,
    /<link rel="alternate" hreflang="en" href="\.\/">/,
  );
  assert.match(
    english,
    /<link rel="alternate" hreflang="zh-CN" href="zh-CN\/">/,
  );
  assert.match(
    english,
    /<link rel="alternate" hreflang="x-default" href="\.\/">/,
  );
  assert.match(
    chinese,
    /<link rel=["']alternate["'] hreflang=["']en["'] href=["']\.\.\/["']>/,
  );
  assert.match(
    chinese,
    /<link rel=["']alternate["'] hreflang=["']zh-CN["'] href=["']\.\/["']>/,
  );
  assert.match(
    chinese,
    /<link rel=["']alternate["'] hreflang=["']x-default["'] href=["']\.\.\/["']>/,
  );
  assert.match(english, /<a href="zh-CN\/" lang="zh-CN">简体中文<\/a>/);
  assert.match(chinese, /<a href=["']\.\.\/["'][^>]*>English<\/a>/);

  assert.deepEqual(
    captures(chinese, /<section\s+id=["']([^"']+)["']/g),
    captures(english, /<section\s+id=["']([^"']+)["']/g),
  );
  assert.deepEqual(
    captures(chinese, /<symbol\s+id=["']([^"']+)["']/g),
    captures(english, /<symbol\s+id=["']([^"']+)["']/g),
  );
  assert.deepEqual(
    captures(chinese, /<code>([^<]+)<\/code>/g),
    captures(english, /<code>([^<]+)<\/code>/g),
  );
  assert.equal(
    captures(chinese, /<style>([\s\S]*?)<\/style>/g)[0],
    captures(english, /<style>([\s\S]*?)<\/style>/g)[0],
  );

  for (const page of [english, chinese]) {
    assert.match(page, /<\/html>\s*$/);
    assert.equal(/<script\b/i.test(page), false);
    for (const token of [
      "embassy dashboard --live",
      "gateway-dashboard.html",
      "gateway-dashboard.zh-CN.html",
      "unconfirmed",
      "ambiguous",
      "held",
      "127.0.0.1",
    ]) {
      assert.ok(page.includes(token), token);
    }
  }
});
