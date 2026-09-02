import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { gatewayControlMethods } from "../src/gateway/control.js";

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
 * localization and the `--lang` switch. Nothing shipped may advertise any of
 * them again. This is the inverse of the contract tests those slices deleted:
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
] as const;

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
  return [
    "README.md",
    "SECURITY.md",
    "CONTRIBUTING.md",
    "AGENTS.md",
    ...site,
    ...docs,
    ...skill,
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
  assert.ok(files.length >= 8, `only ${String(files.length)} documents scanned`);
  assert.equal(files.some((file) => isHistory(file)), false);

  const offenders: string[] = [];
  for (const file of files) {
    const text = await readFile(path.join(repoRoot, file), "utf8");
    for (const term of FORBIDDEN) {
      if (text.includes(term)) offenders.push(`${file}: ${term}`);
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

// The tests below moved here from test/public-localization.test.ts (deleted by
// emb-102). Each pins an English fact; the en/zh parity checks died with the
// second language.

test("authority docs match the closed control contract", async () => {
  const [readme, architecture, skill, changelog, site] = await Promise.all([
    readPublicFile("README.md"),
    readPublicFile("docs/GATEWAY-ARCHITECTURE.md"),
    readPublicFile("skills/embassy-peer/SKILL.md"),
    readPublicFile("CHANGELOG.md"),
    readPublicFile("site/index.html"),
  ]);
  assert.match(architecture, /closed version 3 method family is exactly these twenty methods/i);
  for (const method of gatewayControlMethods) assert.match(architecture, new RegExp(`\\b${method}\\b`));
  assert.match(architecture, /Pair and unpair mutate only the exact two\s+named endpoints/);
  assert.match(architecture, /Paired mode still rechecks exact edge membership at\s+delivery/);
  assert.match(architecture, /operating\s+norm, not an additional gateway identity check/);
  for (const document of [readme, architecture, skill]) {
    assert.match(document, /same-UID.*private control socket/is);
    assert.match(
      document,
      /Remov(?:ing|es?) the selected route,?\s+(?:also\s+)?removes? its incident consent edges,?\s+and settles?/i,
    );
    assert.doesNotMatch(
      document,
      /select-claude[^\n]*shorthand|pair[^\n]*inherited `CODEX_THREAD_ID`/i,
    );
  }
  assert.match(skill, /UUID recovery applies only to selection/);
  assert.match(site, /embassy pair --from codex-embassy@this-mac --to claude-main@this-mac/);
  assert.doesNotMatch(site, /embassy pair --from claude-main@this-mac --to dsh-main@this-mac/);
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

test("progress-watch docs state disabled and idle-timeout behavior exactly", async () => {
  const [configuration, architecture, readme] = await Promise.all([
    readPublicFile("docs/CONFIGURATION.md"),
    readPublicFile("docs/GATEWAY-ARCHITECTURE.md"),
    readPublicFile("README.md"),
  ]);
  assert.match(configuration, /TRACK:` open attempts/);
  assert.match(configuration, /`DONE:` is inert/);
  assert.match(configuration, /`untrack` is not specially rejected.*`NOT_FOUND`/);
  for (const document of [architecture, readme]) {
    assert.doesNotMatch(document, /watch reports a stall/);
    assert.match(document, /watch history/);
    assert.match(document, /no runtime stall alert/);
  }
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
