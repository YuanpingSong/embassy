import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { gatewayCliCommands } from "../src/gateway/cli.js";
import { gatewayControlMethods, isGatewayAlias } from "../src/gateway/control.js";

/** The counts the docs spell out in words; grows when the surfaces do. */
const NUMBER_WORDS: Readonly<Record<number, string>> = { 14: "fourteen", 17: "seventeen" };

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

async function readPublicFile(relativePath: string): Promise<string> {
  return await readFile(path.join(repoRoot, relativePath), "utf8");
}

/**
 * Terms that named deleted surfaces. emb-100 removed the static and live
 * dashboards; emb-101 removed the ACP-backed DeepSeek and Grok providers, the
 * offline support matrix, and the `doctor` command; emb-102 removed the zh-CN
 * localization and the `--lang` switch; emb-103 removed progress watches
 * (`TRACK:`/`DONE:`, `--track`, `untrack`, the liveness nudge); emb-104 removed
 * consent edges outright — `pair`/`unpair`, `select-claude`/`unselect-claude`,
 * `serve --inbound`, and `EMBASSY_MAX_PAIRS` — so a discovered Claude session's
 * route installs on its first use and the OS boundary is the whole permission;
 * emb-109 retired Codex Desktop as a documented host and reduced the site to a
 * stub. Nothing shipped may advertise any of them again. This is the inverse of the contract tests those slices deleted:
 * they proved the documented contract was current, this one proves there is
 * no such contract left to document.
 */
const FORBIDDEN = [
  "dashboard --live",
  "refresh-dashboard",
  "gateway-dashboard",
  "41961",
  "X-Embassy-Request",
  "remove_codex_registration",
  "DeepSeek",
  "Grok",
  "dsh-",
  "grok-",
  "ACP",
  "embassy doctor",
  "provider-support-matrix",
  "support matrix",
  // No release note names the versions any drill ran against yet; a true
  // sentence returns only when one does.
  "tested versions are listed",
  "versions each release was tested with",
  "CHANGELOG records",
  "CHANGELOG lists",
  // emb-101 bumped the private state schema to 5 and narrowed the providers.
  "v4 state",
  "private v4",
  "schema-4",
  "schema 4",
  "four providers",
  "twelve directions",
  // emb-102: one language, no locale switch.
  "--lang",
  "zh-CN",
  // emb-103: no progress watches; TRACK:/DONE: are ordinary body text.
  "--track",
  "TRACK:",
  "DONE:",
  "untrack",
  "idle-minutes",
  "progress watch",
  "liveness check",
  // emb-106: nodes.json is optional, defaulting to a hostname-named single
  // machine; the mandatory-inventory refusal code no longer exists. Both
  // literal forms guard against the exact backticked prose emb-89 shipped
  // ("mandatory nodes.json" alone never occurs adjacent in markdown).
  "mandatory private `nodes.json`",
  "mandatory `nodes.json`",
  "GATEWAY_NODE_INVENTORY_REQUIRED",
  // emb-104: no consent edges, no selection step, no inbound mode.
  "select-claude",
  "unselect-claude",
  "embassy pair",
  "unpair",
  "SENDER_NOT_PAIRED",
  "consent edge",
  "--inbound",
  "EMBASSY_MAX_PAIRS",
  // emb-109: Codex Desktop is not a documented host; the broken attachment
  // flag, the build it broke in, and the upstream issue go with it.
  "Desktop",
  "desktop task",
  "CODEX_APP_SERVER_USE_LOCAL_DAEMON",
  "26.820",
  "codex#41112",
  // emb-109: not even a bare mention of the deleted surfaces, the glob that
  // named the deleted copy tables, the second language, or the deleted site
  // stylesheet.
  "dashboard",
  "Dashboard",
  "*copy*.ts",
  "bilingual",
  "en/zh",
  "style.css",
] as const;

/**
 * emb-106, the same claim written as prose rather than as one of the exact
 * backticked phrases above: `nodes.json` is optional now, so nothing shipped
 * may call it mandatory in any wording, at any distance a single sentence can
 * put between the two words.
 */
const FORBIDDEN_PATTERNS: readonly RegExp[] = [
  /The file is mandatory/i,
  /mandatory[\s\S]{0,60}nodes\.json/i,
  /nodes\.json[\s\S]{0,60}mandatory/i,
  // emb-109: no "tested" claim about an App Server build before the drill;
  // the schema the adapter targets is a design fact, a test is a record.
  // Word-anchored, because every "attested App Server transport" is fine.
  /\btested App Server/i,
  /\btested (?:with )?0\.147/i,
];

/**
 * CHANGELOG.md, .github/release-notes/*, and docs/DECLINED.md are history: they
 * must keep naming what past releases shipped and what we refused to build.
 */
const isHistory = (relativePath: string): boolean =>
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

async function shippedDocuments(): Promise<string[]> {
  const docs = (await walk("docs")).filter((file) => file.endsWith(".md"));
  const skill = await walk("skills/embassy-peer");
  const site = await walk("site");
  // Issue templates are shipped guidance too: they tell a stranger which
  // commands to run, and they sat outside this oracle while they still named
  // `select-claude` long after it was deleted.
  const templates = await walk(".github/ISSUE_TEMPLATE");
  // The PR template and the repo's agent definitions are guidance too: the
  // agent file taught a 2.0-era verb list and a second language for a whole
  // slice after both were deleted.
  const agents = await walk(".claude/agents");
  return [
    "README.md",
    "SECURITY.md",
    "CONTRIBUTING.md",
    "AGENTS.md",
    ".github/PULL_REQUEST_TEMPLATE.md",
    ...site,
    ...docs,
    ...skill,
    ...templates,
    ...agents,
  ]
    .filter((file) => !isHistory(file))
    .sort();
}

test("no shipped document advertises a deleted surface", async () => {
  const files = await shippedDocuments();
  // Guard the guard: an empty or truncated file list would pass vacuously.
  assert.ok(files.includes("README.md"));
  assert.ok(files.includes("SECURITY.md"));
  assert.ok(files.includes("docs/GATEWAY-ARCHITECTURE.md"));
  assert.ok(files.includes("skills/embassy-peer/SKILL.md"));
  assert.ok(files.includes(".github/ISSUE_TEMPLATE/bug_report.yml"));
  assert.ok(files.includes(".github/ISSUE_TEMPLATE/setup_help.yml"));
  assert.ok(files.includes(".github/PULL_REQUEST_TEMPLATE.md"));
  assert.ok(files.includes(".claude/agents/content-writer.md"));
  assert.ok(files.includes("site/zh-CN/index.html"));
  assert.ok(files.length >= 10, `only ${String(files.length)} documents scanned`);
  assert.equal(files.some((file) => isHistory(file)), false);

  const offenders: string[] = [];
  for (const file of files) {
    const raw = await readFile(path.join(repoRoot, file), "utf8");
    // Match against whitespace-collapsed text: a hard-wrapped "consent\nedges"
    // is the same claim as "consent edges", and a plain `includes` missed it
    // for a whole slice. Every forbidden term is normalized the same way.
    const text = raw.replace(/\s+/g, " ");
    for (const term of FORBIDDEN) {
      if (text.includes(term.replace(/\s+/g, " "))) offenders.push(`${file}: ${term}`);
    }
    for (const pattern of FORBIDDEN_PATTERNS) {
      if (pattern.test(raw) || pattern.test(text)) offenders.push(`${file}: ${pattern.source}`);
    }
  }
  // The registry listing is shipped text too: its description and keywords
  // are the first sentence most people read.
  const pkg = JSON.parse(await readPublicFile("package.json")) as { description: string; keywords: string[] };
  for (const [label, field] of [["package.json description", pkg.description], ["package.json keywords", pkg.keywords.join(" ")]] as const) {
    for (const term of FORBIDDEN) if (field.includes(term)) offenders.push(`${label}: ${term}`);
  }
  assert.deepEqual(offenders, []);
});

/**
 * A merge that was never finished must not ship. emb-106 pushed a README whose
 * quickstart still carried `<` `<` `<` markers from a conflict resolved in
 * every file but that one, and nothing in the suite noticed: the docs tests
 * check for terms, not for structure. This is the structural check. The
 * markers are assembled rather than written literally so this file cannot
 * match itself, and the scan covers everything the package ships, history
 * included — a conflict marker is never correct in any of them.
 */
test("no shipped file carries an unresolved merge conflict", async () => {
  const marker = new RegExp(`^(${"<".repeat(7)}|${"=".repeat(7)}|${">".repeat(7)})( |$)`, "m");
  const packaged = (JSON.parse(await readPublicFile("package.json")) as { files: string[] }).files;
  const roots = ["src", "test", "docs", "site", "skills", "scripts", ...packaged];
  const named = ["README.md", "CHANGELOG.md", "SECURITY.md", "CONTRIBUTING.md", "AGENTS.md", "package.json"];
  const files = new Set<string>(named);
  for (const root of roots) {
    let stats;
    try {
      stats = await stat(path.join(repoRoot, root));
    } catch {
      continue; // A packaged build artifact that this checkout has not built.
    }
    if (stats.isDirectory()) for (const found of await walk(root)) files.add(found);
    else files.add(root);
  }
  assert.ok(files.has("README.md") && files.has("src/gateway/cli.ts") && files.has("site/index.html"));
  assert.ok(files.size >= 50, `only ${String(files.size)} files scanned`);

  const offenders: string[] = [];
  for (const file of [...files].sort()) {
    if (/\.(png|jpg|jpeg|gif|ico|woff2?)$/.test(file)) continue;
    const text = await readFile(path.join(repoRoot, file), "utf8");
    const found = marker.exec(text);
    if (found !== null) {
      offenders.push(`${file}:${String(text.slice(0, found.index).split("\n").length)}`);
    }
  }
  assert.deepEqual(offenders, []);
});

/**
 * emb-102 deleted the zh-CN localization outright. Nothing shipped may carry
 * CJK text again: not source, not tests, not docs, not the site, not the
 * skill, not the scripts. CHANGELOG.md and .github/release-notes/ are history
 * and sit outside the scanned roots.
 */
test("no shipped file carries CJK text", async () => {
  const roots = ["src", "test", "docs", "site", "skills", "scripts"] as const;
  const files = [
    "README.md",
    ...(await Promise.all(roots.map((root) => walk(root)))).flat(),
  ].sort();
  assert.ok(files.includes("src/gateway/claude-peer.ts"));
  assert.ok(files.includes("src/gateway/cli.ts"));
  assert.ok(files.includes("test/public-docs.test.ts"));
  assert.ok(files.includes("site/index.html"));
  assert.ok(files.length >= 40, `only ${String(files.length)} files scanned`);

  const offenders: string[] = [];
  for (const file of files) {
    const text = await readFile(path.join(repoRoot, file), "utf8");
    const match = /[\u4e00-\u9fff]/u.exec(text);
    if (match !== null) {
      const line = text.slice(0, match.index).split("\n").length;
      offenders.push(`${file}:${String(line)}`);
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
  // onto every message event, so no shipped text — the issue templates that
  // tell a stranger what is safe to paste included — may call that output
  // metadata-only or say it excludes bodies.
  const denials: readonly RegExp[] = [
    /metadata-only (?:status|snapshot)/i,
    /(?:status|snapshot)[^.\n]{0,120}\bexcludes?\b[^.\n]{0,60}\bbod(?:y|ies)\b/i,
    /\b(?:excludes|omits|without) (?:message )?bod(?:y|ies)\b/i,
  ];
  const offenders: string[] = [];
  for (const file of await shippedDocuments()) {
    const text = await readFile(path.join(repoRoot, file), "utf8");
    for (const pattern of denials) if (pattern.test(text)) offenders.push(`${file}: ${pattern.source}`);
  }
  assert.deepEqual(offenders, []);
  assert.match(readme, /status snapshot that includes retained message bodies/);
  assert.match(
    readme,
    /`embassy status` shows retained bodies; treat its output as sensitive as the messages themselves\./,
  );
  assert.match(architecture, /pane also carries the bounded ledger's retained message bodies/);
});

// The tests below moved here from test/public-localization.test.ts (deleted by
// emb-102). Each pins an English fact; the en/zh parity checks died with the
// second language.

test("authority docs match the closed control contract", async () => {
  const [readme, architecture, skill, changelog, site, agent] = await Promise.all([
    readPublicFile("README.md"),
    readPublicFile("docs/GATEWAY-ARCHITECTURE.md"),
    readPublicFile("skills/embassy-peer/SKILL.md"),
    readPublicFile("CHANGELOG.md"),
    readPublicFile("site/index.html"),
    readPublicFile(".claude/agents/content-writer.md"),
  ]);
  // Both counts are pinned here and spelled out in the docs; the words are
  // derived from the arrays, so a surface that grows or shrinks fails here
  // until every sentence that states the count is corrected.
  assert.equal(gatewayControlMethods.length, 14);
  assert.equal(gatewayCliCommands.length, 17);
  const methodsWord = NUMBER_WORDS[gatewayControlMethods.length];
  const commandsWord = NUMBER_WORDS[gatewayCliCommands.length];
  assert.ok(methodsWord !== undefined && commandsWord !== undefined, "add the new count to NUMBER_WORDS");
  assert.match(architecture, new RegExp(`closed version 3 method family is exactly these ${methodsWord} methods`, "i"));
  for (const method of gatewayControlMethods) assert.match(architecture, new RegExp(`\\b${method}\\b`));
  assert.match(architecture, new RegExp(`${commandsWord} implemented commands`));
  assert.match(readme, new RegExp(`lists all ${commandsWord} commands`));
  assert.match(agent, new RegExp(`exactly these\\s+${commandsWord}:`));
  for (const command of gatewayCliCommands) assert.match(agent, new RegExp(`\\b${command}\\b`), command);
  // The permission model in one sentence, in every authority document.
  assert.match(architecture, /A session already bound under the\s+same \(host, session UUID\) keeps its registration/);
  assert.match(architecture, /operating norm, not an additional gateway identity\s+check/);
  assert.match(architecture, /`serve` takes no options/);
  for (const document of [readme, architecture, skill]) {
    assert.match(document, /same-UID.*private control socket/is);
    assert.match(document, /route[^.]{0,60}on its first use/i);
    assert.match(document, /PEER_ALIAS_COLLISION/);
  }
  assert.match(site, /embassy status/);
  // The placeholder is grammar-valid, so a literal paste reaches the CLI's
  // host-mismatch hint instead of a flat rejection; every surface that uses
  // it says what to substitute.
  assert.match(site, /Each command is what the shipped CLI accepts once you substitute your host\./);
  for (const document of [readme, skill]) assert.match(document, /your-host/);
  // No shouted placeholder host survives anywhere: the earlier form failed the
  // alias grammar, so pasting it never reached the hint that explains it.
  assert.doesNotMatch(readme + skill + site, /@[A-Z]{2,}/);
  // Every placeholder alias must pass the CLI's own grammar: a literal paste
  // has to reach the host-mismatch hint, not a flat rejection ahead of it.
  const placeholders = [...`${readme}\n${skill}\n${site}`.matchAll(/[a-z][a-z0-9_-]*@your-host/g)].map((found) => found[0]);
  assert.ok(placeholders.length >= 10, `only ${String(placeholders.length)} placeholder aliases found`);
  for (const alias of new Set(placeholders)) assert.equal(isGatewayAlias(alias), true, alias);
  assert.match(changelog, /private control protocol is version 2/i);
  assert.match(changelog, /### Removed[\s\S]*legacy `--claude` \/ `--codex` arm is removed/);
  assert.match(changelog, /private state reset/);
  assert.match(changelog, /mandatory private `nodes\.json`/);
  assert.match(changelog, /was never enforced by the surviving generic arm/);
  assert.match(changelog, /Authority-model correction:/);
});

test("README and delivery docs describe universal shell peer identity and receipt semantics", async () => {
  const [readme, delivery] = await Promise.all([
    readPublicFile("README.md"),
    readPublicFile("docs/DELIVERY.md"),
  ]);
  for (const token of [
    "peer-*",
    "register-peer",
    "--token-stdin",
    "--emit-env",
    "embassy await",
    "unconfirmed",
    "ambiguous",
  ]) assert.ok(readme.includes(token), token);
  assert.match(readme, /30[- ]second/);
  assert.match(readme, /stdout/);
  assert.match(delivery, /PEER_NOT_AWAITING/);
  assert.match(delivery, /One waiter.*16 globally/);
});

test("public docs document provenance framing and recipient continuation", async () => {
  const [readme, delivery, configuration, site] = await Promise.all([
    readPublicFile("README.md"),
    readPublicFile("docs/DELIVERY.md"),
    readPublicFile("docs/CONFIGURATION.md"),
    readPublicFile("site/index.html"),
  ]);
  for (const document of [readme, delivery]) {
    assert.ok(document.includes("cross-session-message"));
    assert.ok(document.includes("embassy-reply-hint"));
    assert.ok(document.includes("conv_"));
    assert.ok(document.includes("reply"));
  }
  for (const document of [configuration, site]) {
    assert.ok(document.includes("conv_"));
    assert.ok(document.includes("reply"));
  }
  assert.doesNotMatch(readme, /raw anonymous body/i);
  assert.doesNotMatch(readme, /recipient currently receives no/i);

  const hopPolicyPaths = [
    "README.md",
    "SECURITY.md",
    "AGENTS.md",
    "CONTRIBUTING.md",
    "docs/DELIVERY.md",
    "docs/CONFIGURATION.md",
    "docs/GATEWAY-ARCHITECTURE.md",
    "site/index.html",
  ] as const;
  const hopPolicyDocuments = await Promise.all(hopPolicyPaths.map(readPublicFile));
  for (const [index, document] of hopPolicyDocuments.entries()) {
    assert.doesNotMatch(
      document,
      /EMBASSY_MAX_HOPS|HOP_LIMIT_EXCEEDED|conversations? (?:are|is) hop[- ]bounded|hop[- ]bounded conversations?/i,
      hopPolicyPaths[index] ?? "unknown",
    );
  }
});

test("delivery-token documentation preserves restart continuity", async () => {
  const [delivery, architecture, readme] = await Promise.all([
    readPublicFile("docs/DELIVERY.md"),
    readPublicFile("docs/GATEWAY-ARCHITECTURE.md"),
    readPublicFile("README.md"),
  ]);
  assert.match(delivery, /retained pre-restart token continues to resolve/i);
  assert.match(delivery, /never enters a public snapshot, normal log, or provider receipt/i);
  assert.match(architecture, /delivery token and status of each retained message survive the restart/i);
  assert.match(readme, /opaque delivery token\/status persist/i);
  for (const document of [delivery, architecture]) {
    assert.doesNotMatch(document, /delivery tokens? remain memory-only|prior token therefore returns `found: false`/i);
  }
});

test("advertisement guidance includes shell peers, not a singleton Codex record", async () => {
  const forbidden = (sentence: string): boolean => !/peer-\*/i.test(sentence) &&
    /\b(?:records?|entries|entry|peers?)\b/i.test(sentence) &&
    ((/\b(?:process|gateway)-owned\b/i.test(sentence) && /\bcodex\b/i.test(sentence)) ||
     (/codex-\*/i.test(sentence) && /\b(?:one|single|sole)\b/i.test(sentence)));
  for (const offender of [
    "The gateway may publish one process-owned `codex-*` peer so Claude's native `ListAgents` and `SendMessage` tools can reach Codex.",
    "Any exact compatible live same-UID Claude session may reach the one registered `codex-*` peer, and its own route is installed by that first native send.",
  ]) assert.equal(forbidden(offender), true, offender);
  for (const file of ["README.md", "AGENTS.md", "SECURITY.md", "CONTRIBUTING.md", "docs/GATEWAY-ARCHITECTURE.md", "skills/embassy-peer/SKILL.md"]) {
    const document = await readPublicFile(file);
    for (const sentence of document.split(/(?<=[.!?])\s+|\n\s*\n|\n(?=\|)/)) {
      assert.equal(forbidden(sentence.replace(/\s+/g, " ")), false, `${file}: ${sentence}`);
    }
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
  // emb-100 deleted the browser-origin doctrine bullet along with the browser
  // surface it described; Embassy now creates no network listener at all.
  assert.doesNotMatch(security, /browser can issue or read across origins/);
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
  const guidancePaths = [
    "README.md",
    "docs/DELIVERY.md",
    "site/index.html",
    "skills/embassy-peer/SKILL.md",
    "docs/GATEWAY-ARCHITECTURE.md",
  ] as const;
  const guidance = await Promise.all(guidancePaths.map(readPublicFile));
  for (const [index, document] of guidance.entries()) {
    const label = guidancePaths[index] ?? "unknown";
    assert.match(document, /Claude-bound/i, label);
    assert.match(document, /mailbox/i, label);
    assert.match(document, /transport_written/i, label);
    assert.match(document, /delivered/i, label);
    assert.match(document, /Codex-bound/i, label);
  }
  for (const [index, document] of guidance.slice(0, 3).entries()) {
    assert.doesNotMatch(
      document,
      /toward Claude, the message was released into the session's native queue|Answers arrive at turn boundaries, queued honestly|<b>queues never interrupt<\/b>/i,
      guidancePaths[index] ?? "unknown",
    );
  }
});

test("marketing page preserves structure and protocol tokens", async () => {
  const page = await readPublicFile("site/index.html");
  assert.match(page, /<html lang="en">/);
  assert.match(
    page,
    /<link rel="alternate" hreflang="en" href="https:\/\/yuanpingsong\.github\.io\/embassy\/">/,
  );
  assert.match(
    page,
    /<link rel="alternate" hreflang="x-default" href="https:\/\/yuanpingsong\.github\.io\/embassy\/">/,
  );
  assert.match(page, /<\/html>\s*$/);
  assert.equal(/<script[^>]*\ssrc=/i.test(page), false);
  for (const token of ["unconfirmed", "ambiguous", "held"]) {
    assert.ok(page.includes(token), token);
  }
});
