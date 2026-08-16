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

test("progress-watch docs state disabled and idle-timeout behavior exactly", async () => {
  const [englishConfig, chineseConfig, architecture, englishReadme, chineseReadme] =
    await Promise.all([
      readPublicFile("docs/CONFIGURATION.md"),
      readPublicFile("docs/CONFIGURATION.zh-CN.md"),
      readPublicFile("docs/GATEWAY-ARCHITECTURE.md"),
      readPublicFile("README.md"),
      readPublicFile("README.zh-CN.md"),
    ]);

  assert.match(englishConfig, /TRACK:` open attempts/);
  assert.match(englishConfig, /`DONE:` is inert/);
  assert.match(englishConfig, /`untrack` is not specially rejected.*`NOT_FOUND`/);
  assert.match(chineseConfig, /`TRACK:` 开启请求会被拒绝/);
  assert.match(chineseConfig, /`DONE:` 不产生作用/);
  assert.match(chineseConfig, /`untrack` 不会因开关而被特别拒绝.*`NOT_FOUND`/);
  for (const document of [architecture, englishReadme]) {
    assert.doesNotMatch(document, /watch reports a stall/);
    assert.match(document, /watch history/);
    assert.match(document, /no runtime stall alert/);
  }
  assert.doesNotMatch(chineseReadme, /监视报告停滞/);
  assert.match(chineseReadme, /只在监视历史中记录该结算/);
  assert.match(chineseReadme, /不会发出运行时停滞告警/);
});

test("public locales document provenance framing and recipient continuation", async () => {
  const [
    englishReadme,
    chineseReadme,
    englishDelivery,
    chineseDelivery,
    englishConfiguration,
    chineseConfiguration,
    englishSite,
    chineseSite,
  ] = await Promise.all([
    readPublicFile("README.md"),
    readPublicFile("README.zh-CN.md"),
    readPublicFile("docs/DELIVERY.md"),
    readPublicFile("docs/DELIVERY.zh-CN.md"),
    readPublicFile("docs/CONFIGURATION.md"),
    readPublicFile("docs/CONFIGURATION.zh-CN.md"),
    readPublicFile("site/index.html"),
    readPublicFile("site/zh-CN/index.html"),
  ]);

  for (const document of [
    englishReadme,
    chineseReadme,
    englishDelivery,
    chineseDelivery,
  ]) {
    assert.ok(document.includes("cross-session-message"));
    assert.ok(document.includes("embassy-reply-hint"));
    assert.ok(document.includes("conv_"));
    assert.ok(document.includes("reply"));
  }

  for (const document of [englishConfiguration, chineseConfiguration]) {
    assert.ok(document.includes("conv_"));
    assert.ok(document.includes("reply"));
  }

  for (const page of [englishSite, chineseSite]) {
    assert.ok(page.includes("conv_"));
    assert.ok(page.includes("reply"));
  }

  assert.doesNotMatch(englishReadme, /raw anonymous body/i);
  assert.doesNotMatch(englishReadme, /recipient currently receives no/i);
  const hopPolicyPaths = [
    "README.md",
    "README.zh-CN.md",
    "SECURITY.md",
    "AGENTS.md",
    "CONTRIBUTING.md",
    "docs/DELIVERY.md",
    "docs/DELIVERY.zh-CN.md",
    "docs/CONFIGURATION.md",
    "docs/CONFIGURATION.zh-CN.md",
    "docs/GATEWAY-ARCHITECTURE.md",
    "site/index.html",
    "site/zh-CN/index.html",
  ] as const;
  const hopPolicyDocuments = await Promise.all(
    hopPolicyPaths.map(readPublicFile),
  );
  for (const [index, document] of hopPolicyDocuments.entries()) {
    const label = hopPolicyPaths[index] ?? "unknown";
    assert.doesNotMatch(
      document,
      /EMBASSY_MAX_HOPS|HOP_LIMIT_EXCEEDED|conversations? (?:are|is) hop[- ]bounded|hop[- ]bounded conversations?|跳数/iu,
      label,
    );
  }
});

test("current dashboard docs use the stable direct-loopback contract", async () => {
  const paths = [
    "README.md",
    "README.zh-CN.md",
    "SECURITY.md",
    "CONTRIBUTING.md",
    "docs/DASHBOARD.md",
    "docs/DASHBOARD.zh-CN.md",
    "docs/CONFIGURATION.md",
    "docs/CONFIGURATION.zh-CN.md",
    "docs/GATEWAY-ARCHITECTURE.md",
    "docs/THREAT-MODEL-dashboard-mutations.md",
    "skills/embassy-peer/SKILL.md",
    "site/index.html",
    "site/zh-CN/index.html",
  ] as const;
  const documents = await Promise.all(paths.map(readPublicFile));

  for (const [index, document] of documents.entries()) {
    const label = paths[index] ?? "unknown";
    assert.ok(document.includes("41961"), `${label}: stable default port`);
    assert.ok(document.includes("--port"), `${label}: CLI port override`);
    assert.doesNotMatch(document, /EMBASSY_DASHBOARD_PORT/, label);
    assert.doesNotMatch(
      document,
      /ephemeral port|OS-assigned port|URL-fragment token|session cookie|bootstrap\.html|one-use (?:256-bit )?(?:URL-fragment )?(?:token|capability)|authenticated (?:HTTP listener|listener|live dashboard|session|snapshot stream|fetch|POST)/i,
      label,
    );
  }

  for (const path of [
    "README.zh-CN.md",
    "docs/DASHBOARD.zh-CN.md",
    "docs/CONFIGURATION.zh-CN.md",
    "site/zh-CN/index.html",
  ]) {
    const document = await readPublicFile(path);
    assert.doesNotMatch(document, /临时端口|一次性.{0,12}令牌|会话 Cookie/u, path);
  }
});

test("security doctrine names defended and deliberately unsupported boundaries", async () => {
  const [security, agents, contributing] = await Promise.all([
    readPublicFile("SECURITY.md"),
    readPublicFile("AGENTS.md"),
    readPublicFile("CONTRIBUTING.md"),
  ]);

  assert.ok(
    security.includes("## What Embassy defends, and what it deliberately does not"),
  );
  assert.match(security, /same-UID OS and artifact boundary/);
  assert.match(security, /canonical paths, ownership/);
  assert.match(security, /symlink policy, modes, approved version-directory containment/);
  assert.match(security, /identity-bearing input/);
  assert.match(security, /Claude-owned external sessions registry root is instead a read-side identity/);
  assert.match(security, /unsafe UID or mode evidence quarantines and write-fences only Claude/);
  assert.match(security, /external sessions registry root must be owned by the current\s+UID with exact mode 0700/);
  assert.match(security, /invents no additional owner or mode rule for those individual\s+provider-owned artifacts/);
  assert.match(security, /reserved framing tags/);
  assert.match(security, /every delivered\s+body remains untrusted input/);
  assert.match(security, /Anti-runaway containment/);
  assert.match(security, /no local-process authentication/);
  assert.match(security, /no capability or local-user consent/);
  assert.match(security, /browser can issue or read across origins/);
  assert.match(security, /Every new audit check must cite the sentence in this doctrine/);
  assert.match(security, /doctrine-change proposal/);
  assert.match(security, /must not\s+silently expand Embassy's claimed boundary/);

  for (const document of [agents, contributing]) {
    assert.match(document, /What Embassy defends, and what it deliberately does not/);
    assert.match(document, /Every new audit check|every new audit check/);
    assert.match(document, /doctrine-change proposal|propose the doctrine change/);
    assert.match(document, /silently expand|boundary expansion/);
    assert.match(document, /Claude-owned external\s+sessions registry root/);
    assert.match(document, /quarantines\s+(?:and write-fences\s+)?only Claude/);
  }
});


test("current public guidance preserves directional delivery timing", async () => {
  const [
    englishReadme,
    chineseReadme,
    englishDelivery,
    chineseDelivery,
    englishDashboard,
    chineseDashboard,
    englishSite,
    chineseSite,
    skill,
    architecture,
  ] = await Promise.all([
    readPublicFile("README.md"),
    readPublicFile("README.zh-CN.md"),
    readPublicFile("docs/DELIVERY.md"),
    readPublicFile("docs/DELIVERY.zh-CN.md"),
    readPublicFile("docs/DASHBOARD.md"),
    readPublicFile("docs/DASHBOARD.zh-CN.md"),
    readPublicFile("site/index.html"),
    readPublicFile("site/zh-CN/index.html"),
    readPublicFile("skills/embassy-peer/SKILL.md"),
    readPublicFile("docs/GATEWAY-ARCHITECTURE.md"),
  ]);

  for (const [label, document] of [
    ["README.md", englishReadme],
    ["docs/DELIVERY.md", englishDelivery],
    ["docs/DASHBOARD.md", englishDashboard],
    ["site/index.html", englishSite],
    ["skills/embassy-peer/SKILL.md", skill],
    ["docs/GATEWAY-ARCHITECTURE.md", architecture],
  ] as const) {
    assert.match(document, /Claude-bound/i, label);
    assert.match(document, /mailbox/i, label);
    assert.match(document, /transport_written/i, label);
    assert.match(document, /delivered/i, label);
    assert.match(document, /Codex-bound/i, label);
  }

  for (const [label, document] of [
    ["README.zh-CN.md", chineseReadme],
    ["docs/DELIVERY.zh-CN.md", chineseDelivery],
    ["docs/DASHBOARD.zh-CN.md", chineseDashboard],
    ["site/zh-CN/index.html", chineseSite],
  ] as const) {
    assert.match(document, /朝向 Claude/u, label);
    assert.match(document, /邮箱/u, label);
    assert.match(document, /transport_written/i, label);
    assert.match(document, /delivered/i, label);
    assert.match(document, /朝向 Codex/u, label);
  }

  for (const [label, document] of [
    ["README.md", englishReadme],
    ["docs/DELIVERY.md", englishDelivery],
    ["site/index.html", englishSite],
  ] as const) {
    assert.doesNotMatch(
      document,
      /toward Claude, the message was released into the session's native queue|Answers arrive at turn boundaries, queued honestly|<b>queues never interrupt<\/b>/i,
      label,
    );
  }
  for (const [label, document] of [
    ["README.zh-CN.md", chineseReadme],
    ["docs/DELIVERY.zh-CN.md", chineseDelivery],
    ["site/zh-CN/index.html", chineseSite],
  ] as const) {
    assert.doesNotMatch(
      document,
      /朝向 Claude，意味着消息已释放到会话的原生队列|答案在回合边界到达，诚实排队|<b>队列绝不打断<\/b>/u,
      label,
    );
  }
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
    /<link rel="alternate" hreflang="en" href="https:\/\/yuanpingsong\.github\.io\/embassy\/">/,
  );
  assert.match(
    english,
    /<link rel="alternate" hreflang="zh-CN" href="https:\/\/yuanpingsong\.github\.io\/embassy\/zh-CN\/">/,
  );
  assert.match(
    english,
    /<link rel="alternate" hreflang="x-default" href="https:\/\/yuanpingsong\.github\.io\/embassy\/">/,
  );
  assert.match(
    chinese,
    /<link rel=["']alternate["'] hreflang=["']en["'] href=["']https:\/\/yuanpingsong\.github\.io\/embassy\/["']>/,
  );
  assert.match(
    chinese,
    /<link rel=["']alternate["'] hreflang=["']zh-CN["'] href=["']https:\/\/yuanpingsong\.github\.io\/embassy\/zh-CN\/["']>/,
  );
  assert.match(
    chinese,
    /<link rel=["']alternate["'] hreflang=["']x-default["'] href=["']https:\/\/yuanpingsong\.github\.io\/embassy\/["']>/,
  );
  assert.match(english, /<a href="zh-CN\/" lang="zh-CN">中文<\/a>/);
  assert.match(chinese, /<a href=["']\.\.\/["'][^>]*>English<\/a>/);

  assert.deepEqual(
    captures(chinese, /<section[^>]*\sid=["']([^"']+)["']/g),
    captures(english, /<section[^>]*\sid=["']([^"']+)["']/g),
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
    assert.equal(/<script[^>]*\ssrc=/i.test(page), false);
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
