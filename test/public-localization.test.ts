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
  assert.match(security, /version string is a compatibility\s+observation, never security evidence or attack detection/);
  assert.match(security, /facts outrank prediction\s+from a version string/);
  assert.match(security, /boot refusal is reserved\s+for an unsafe or lost singleton lease, corrupt controller state, or unsafe\s+OS-boundary/);
  assert.match(security, /does\s+not take down the broker or the other provider/);
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

test("current compatibility docs expose the evidence-gated forward contract", async () => {
  const currentPaths = [
    "README.md",
    "README.zh-CN.md",
    "SECURITY.md",
    "AGENTS.md",
    "CONTRIBUTING.md",
    "docs/CONFIGURATION.md",
    "docs/CONFIGURATION.zh-CN.md",
    "docs/DASHBOARD.md",
    "docs/DASHBOARD.zh-CN.md",
    "docs/GATEWAY-ARCHITECTURE.md",
    "site/index.html",
    "site/zh-CN/index.html",
    "skills/embassy-peer/SKILL.md",
  ] as const;
  const documents = await Promise.all(currentPaths.map(readPublicFile));

  for (const [index, document] of documents.entries()) {
    const label = currentPaths[index] ?? "unknown";
    assert.doesNotMatch(
      document,
      /EMBASSY_COMPAT_POLICY|embassy compat-(?:check|certify)\b|--with-turn\b|LaunchAgent|live certification|on-machine certification|在线认证|实时认证|线缆认证/iu,
      label,
    );
    assert.ok(document.includes("thread/resume"), `${label}: bounded Codex resume read`);
    assert.ok(document.includes("turn/start"), `${label}: fenced Codex write boundary`);
    assert.doesNotMatch(
      document,
      /automatic(?:ally)?(?: and)? exact[- ](?:version[- ])?pinned|exact-version-pinned|validates exact reviewed versions automatically|自动且精确固定版本|自动验证精确的已审查版本/iu,
      label,
    );
    assert.doesNotMatch(
      document,
      /unsupported (?:provider |Claude Code )?major (?:still )?refuses broker startup|different major (?:also )?refuses broker startup|fully probed same-major builds? (?:are|is) writable `schema_attested`|不支持的(?:提供方)?主版本.{0,12}拒绝(?:代理)?启动/iu,
      label,
    );
  }

  const [
    englishReadme,
    chineseReadme,
    englishConfiguration,
    chineseConfiguration,
    englishDashboard,
    chineseDashboard,
    architecture,
    skill,
    englishSite,
    chineseSite,
  ] = await Promise.all([
      readPublicFile("README.md"),
      readPublicFile("README.zh-CN.md"),
      readPublicFile("docs/CONFIGURATION.md"),
      readPublicFile("docs/CONFIGURATION.zh-CN.md"),
      readPublicFile("docs/DASHBOARD.md"),
      readPublicFile("docs/DASHBOARD.zh-CN.md"),
      readPublicFile("docs/GATEWAY-ARCHITECTURE.md"),
      readPublicFile("skills/embassy-peer/SKILL.md"),
      readPublicFile("site/index.html"),
      readPublicFile("site/zh-CN/index.html"),
    ]);

  for (const document of [englishConfiguration, chineseConfiguration]) {
    assert.ok(document.includes("peerProtocol: 1"));
    assert.ok(document.includes("schema_attested"));
    assert.ok(document.includes("thread/loaded/list"));
    assert.ok(document.includes("parseableRecordSeenSinceBoot"));
    assert.ok(document.includes("rejectedCodesOmitted"));
  }
  assert.match(englishConfiguration, /certified version on the supported major is writable/i);
  assert.match(englishConfiguration, /same-major build outside the tested inventory appears as `schema_attested`/i);
  assert.match(englishConfiguration, /writable only when those probes cover its write path/i);
  assert.match(englishConfiguration, /Ordinary Codex compatibility and registration reads remain read-only.{0,240}do not invoke `turn\/start`.{0,160}optional Codex write-attestation probe is the sole exception.{0,300}at most one disposable broker-owned thread per attempt.{0,180}bounded write fence with zero user-thread contact.{0,180}every created probe thread is archived and confirmed absent from the loaded set.{0,180}resolves the pinned model's lowest advertised effort.{0,180}Whenever that model\/effort pin cannot resolve, it declines in a zero-spend fail-safe before creating any thread or model turn/is);
  assert.match(englishConfiguration, /untested Codex build therefore stays monitor-only pending a certified write schema/i);
  assert.match(englishConfiguration, /probes fail stays degraded, monitor-only, and write-fenced/i);
  assert.match(englishConfiguration, /different major or version evidence that cannot establish a safe major/i);
  assert.match(englishConfiguration, /can never be promoted by probes/i);
  assert.match(englishConfiguration, /broker, control socket, dashboards, and other provider remain available/i);
  assert.match(englishConfiguration, /Embassy release supporting the observed major is required/i);
  assert.match(englishConfiguration, /Embassy-owned or executed artifacts and Embassy callback, control, or state paths/u);
  assert.match(englishConfiguration, /Claude-owned external sessions registry root.{0,160}quarantines and write-fences only Claude/is);
  assert.match(englishConfiguration, /`embassy health` is not a recovery step/iu);
  assert.match(englishConfiguration, /unknown top-level Claude registry fields are ignored/i);
  assert.match(englishConfiguration, /declares any other value is rejected in isolation/i);
  assert.match(englishConfiguration, /rejectedCodesOmitted/);
  assert.match(chineseConfiguration, /已认证版本.{0,16}可写/u);
  assert.match(chineseConfiguration, /schema_attested.{0,24}只有探测覆盖写入路径时才可写/u);
  assert.match(chineseConfiguration, /常规 Codex 兼容性与注册读取仍保持只读.{0,160}不会调用 `turn\/start`.{0,100}唯一例外是可选的 Codex 写入认证探测.{0,220}每次尝试最多可创建一个代理自有的临时线程.{0,160}有界写入围栏下运行且绝不接触用户线程.{0,160}每个已创建的探测线程都会被归档，并确认已从已加载集合中清除.{0,160}解析固定模型所公布的最低 effort.{0,160}模型\/effort 固定项无法解析.{0,160}以零消耗故障安全方式拒绝.{0,100}不会创建任何线程或模型轮次/us);
  assert.match(chineseConfiguration, /未测试的 Codex 构建.{0,20}保持仅监控/u);
  assert.match(chineseConfiguration, /探测失败.{0,24}降级、仅监控并禁止写入/u);
  assert.match(chineseConfiguration, /主版本不同或版本证据无法建立安全主版本/u);
  assert.match(chineseConfiguration, /绝不能跨主版本或未知主版本提升权限/u);
  assert.match(chineseConfiguration, /代理、控制套接字、仪表盘和另一提供方继续运行/u);
  assert.match(chineseConfiguration, /必须使用支持已观测主版本的 Embassy 发布版/u);
  assert.match(chineseConfiguration, /Embassy 自有或执行的构件及其回调、控制或状态路径/u);
  assert.match(chineseConfiguration, /外部会话注册表根目录.{0,80}只隔离并禁止 Claude 写入/u);
  assert.match(chineseConfiguration, /`embassy health` 不是恢复步骤/u);
  assert.match(chineseConfiguration, /未知.{0,20}Claude 注册表顶层字段.{0,20}忽略/u);
  assert.match(chineseConfiguration, /声明其他值的记录会单独被拒绝/u);

  for (const document of [englishReadme, englishConfiguration, architecture]) {
    assert.match(document, /peer protocol 1|peerProtocol: 1/i);
    assert.match(document, /schema_attested/);
    assert.match(document, /same-major/i);
    assert.match(document, /monitor-only/i);
  }
  assert.match(
    architecture,
    /Startup performs a bounded read-only Claude registry scan solely/,
  );
  assert.match(architecture, /publishes no candidates/);
  assert.match(architecture, /every restored route begins stale/);
  assert.match(architecture, /does not publish candidates, select or connect to a peer/);
  assert.match(architecture, /does not .*request provider history/s);
  assert.match(
    architecture,
    /memory-only validated target bindings, including native IDs and socket-derived/,
  );
  assert.match(architecture, /neither\s+public nor persisted/);
  assert.match(architecture, /none enters public state or persistence/);
  assert.match(architecture, /explicit versioned Embassy-advertisement marker/);
  assert.match(architecture, /genuine unmarked Claude\s+session remains selectable even when its current name begins `codex-`/);
  assert.match(architecture, /external sessions registry root must\s+belong to the current UID with exact mode 0700/);
  assert.match(architecture, /without an\s+invented additional owner or mode rule/);
  for (const document of [chineseReadme, chineseConfiguration]) {
    assert.match(document, /peerProtocol: 1|对等协议.{0,8}1/u);
    assert.match(document, /schema_attested/);
    assert.match(document, /同主版本/u);
    assert.match(document, /仅监控/u);
  }

  for (const document of [englishDashboard, chineseDashboard]) {
    assert.ok(document.includes("schema_attested"));
    assert.ok(document.includes("parseableRecordSeenSinceBoot"));
    assert.ok(document.includes("rejectedCodesOmitted"));
    assert.match(document, /No parseable record since broker start|可解析(?:的)?必需字段/u);
  }

  assert.match(skill, /Compatibility is automatic and evidence-gated/);
  assert.match(skill, /certified same-major provider is writable/i);
  assert.match(skill, /schema-attested \(`schema_attested`\) and writable only when those probes cover the write path/);
  assert.match(skill, /untested Codex 0\.x therefore stays monitor-only/i);
  assert.match(skill, /version evidence that cannot establish a safe major/);
  assert.match(skill, /never promote across a major or unknown major/);
  assert.match(skill, /Embassy release supporting the observed major is required/);
  assert.match(skill, /`peerProtocol 1` is required per registry record/);
  assert.match(skill, /explicit versioned advertisement marker/);
  assert.match(skill, /genuine unmarked Claude session remains visible/);
  assert.match(skill, /replacement generation starts monitor-only/);
  assert.match(englishSite, /compatibility follows evidence/i);
  assert.match(englishSite, /Certified same-major providers are writable/i);
  assert.match(englishSite, /untested Codex 0\.x therefore stays monitor-only/i);
  assert.match(englishSite, /supporting Embassy release/i);
  assert.match(englishSite, /bounded rejection and observed-empty evidence/i);
  assert.match(chineseSite, /兼容性以证据为准/u);
  assert.match(chineseSite, /同主版本的已认证提供方可写/u);
  assert.match(chineseSite, /未测试的 Codex 0\.x.{0,180}保持 monitor-only/us);
  assert.match(chineseSite, /支持它的 Embassy 发布版/u);
  assert.match(chineseSite, /有界拒绝与观察到的空证据/u);

  const [agentsGuidance, contributing] = await Promise.all([
    readPublicFile("AGENTS.md"),
    readPublicFile("CONTRIBUTING.md"),
  ]);
  for (const document of [agentsGuidance, contributing]) {
    assert.match(document, /evidence-gated/i);
    assert.match(document, /peer protocol 1/i);
    assert.match(document, /schema_attested/);
    assert.match(document, /monitor-only/i);
  }
  assert.match(agentsGuidance, /`experimentalApi: true` hard-coded solely for/);
  assert.match(agentsGuidance, /Require an empty `thread\.turns` response/);
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
