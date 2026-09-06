import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import { runCoreCli } from "../src/gateway/core-cli.js";

const root = path.resolve(import.meta.dirname, "..");
const read = async (relative: string): Promise<string> =>
  await readFile(path.join(root, relative), "utf8");
const squash = (value: string): string => value.replace(/\s+/g, " ");

const currentDocs = [
  "AGENTS.md",
  "README.md",
  "SECURITY.md",
  "CONTRIBUTING.md",
  "docs/CONFIGURATION.md",
  "docs/DELIVERY.md",
  "docs/GATEWAY-ARCHITECTURE.md",
  ".claude/agents/content-writer.md",
  ".github/ISSUE_TEMPLATE/setup_help.yml",
] as const;

async function helpText(): Promise<string> {
  const output = new PassThrough();
  let text = "";
  output.setEncoding("utf8");
  output.on("data", (chunk: string) => { text += chunk; });
  assert.equal(await runCoreCli(["--help"], { stdout: output }), 0);
  output.end();
  return text;
}

test("public command list agrees with the side-effect-free CLI help", async () => {
  const [help, readme, architecture, agent] = await Promise.all([
    helpText(), read("README.md"), read("docs/GATEWAY-ARCHITECTURE.md"),
    read(".claude/agents/content-writer.md"),
  ]);
  const commands = [
    "register-codex", "send", "status", "refresh", "delivery-status",
    "wait-delivery", "retire", "check", "health", "serve", "service",
    "peer-stdio",
  ];
  for (const command of commands) {
    assert.match(help, new RegExp(`\\b${command}\\b`), `help omits ${command}`);
    assert.match(readme, new RegExp(`\\b${command}\\b`), `README omits ${command}`);
    assert.match(architecture, new RegExp(`\\b${command}\\b`), `architecture omits ${command}`);
    assert.match(agent, new RegExp(`\\b${command}\\b`), `writer guide omits ${command}`);
  }
  assert.match(help, /send --to <name@host>/);
  assert.match(help, /send --conversation <reference>/);
  assert.match(help, /sender is resolved from the calling Claude\/Codex session/i);
  assert.doesNotMatch(help, /--from|register-peer|unregister-peer|\bawait\b|\bwatch\b|send-to-/);
});

test("quickstart teaches inferred sending, native receiving, and identity-bound replies", async () => {
  const [readme, site, help] = await Promise.all([
    read("README.md"), read("site/index.html"), helpText(),
  ]);
  assert.match(readme, /sender is inferred from the calling session/i);
  assert.match(readme, /embassy send --to claude-reviewer@studio/);
  assert.match(readme, /embassy send --conversation conv_example/);
  assert.match(readme, /\.result\.routes/);
  assert.match(readme, /\{"ok":true,"command":"status","result":\{\.\.\.\}\}/);
  assert.match(readme, /wakes the receiving agent through its native interface/i);
  assert.match(readme, /Claude→Claude, Claude→Codex, Codex→Claude, and Codex→Codex/);
  assert.match(squash(readme), /No helper or native advertisement process is installed/i);
  assert.match(squash(readme), /may survive a broker restart while their retained ledger row and both exact endpoints remain valid/i);
  assert.match(squash(readme), /stop resolving after retirement, replacement, expiry, eviction, or a state reset/i);
  assert.doesNotMatch(readme, /embassy send --from|embassy register-peer|embassy await|embassy watch|send-to-(?:claude|codex)/);
  assert.match(site, /embassy send --to advisor@your-host &lt;&lt;'MSG'/);
  assert.match(site, /embassy send --conversation conv_&lt;reference&gt; &lt;&lt;'MSG'/);
  assert.match(site, /the caller is inferred/i);
  assert.match(help, /embassy send --to <name@host>/);
  assert.match(help, /embassy send --conversation <reference>/);
  assert.doesNotMatch(site, /--from|--expects-reply|shell-peer|register-peer|embassy await/);
});

test("service documentation states launchd's crash-only restart boundary", async () => {
  const [readme, configuration, implementation] = await Promise.all([
    read("README.md"), read("docs/CONFIGURATION.md"), read("src/gateway/service-agent.ts"),
  ]);
  for (const document of [readme, configuration]) {
    assert.match(squash(document), /SIGABRT.*relaunch/i);
    assert.match(squash(document), /kill -9.*(?:leaves it stopped|leaves the service not running)/i);
    assert.match(document, /embassy service status/);
  }
  assert.match(implementation, /<key>KeepAlive<\/key>/);
  assert.match(implementation, /<key>Crashed<\/key>/);
  assert.doesNotMatch(implementation, /<key>KeepAlive<\/key>\s*<true\/>/);
});

test("delivery guide pins batching and the no-replay phase law", async () => {
  const delivery = await read("docs/DELIVERY.md");
  for (const phase of ["queued", "reserved", "armed", "accepted", "terminal"]) {
    assert.match(delivery, new RegExp(`\\b${phase}\\b`));
  }
  assert.match(delivery, /bounded FIFO prefix into one native wake/i);
  assert.match(delivery, /Only an adapter's positive proof that it wrote nothing may return/i);
  assert.match(delivery, /Loss after an armed write is `ambiguous`/);
  assert.match(delivery, /Neither is replayed/);
  assert.match(squash(delivery), /destination .*persists its queue.*returns acceptance/i);
  assert.match(squash(delivery), /does not wait for a catalog poll before accepting first contact/i);
  assert.match(delivery, /embassy send --conversation <reference>/);
});

test("STEER copy preserves its narrow direction and safe boundary", async () => {
  const [readme, delivery, security, architecture] = await Promise.all([
    read("README.md"), read("docs/DELIVERY.md"), read("SECURITY.md"),
    read("docs/GATEWAY-ARCHITECTURE.md"),
  ]);
  for (const document of [readme, delivery, security, architecture]) {
    assert.match(document, /STEER:/);
    assert.match(document, /Claude.to.Codex/is);
    assert.match(document, /(?:safe|tool-call) boundary/i);
    assert.match(document, /(?:never (?:interrupts|invokes)|does not interrupt)/i);
  }
  assert.match(security, /never calls `turn\/interrupt`/);
});

test("protocol and reset documentation pins the v4-only boundary", async () => {
  const [readme, config, architecture, security] = await Promise.all([
    read("README.md"), read("docs/CONFIGURATION.md"),
    read("docs/GATEWAY-ARCHITECTURE.md"), read("SECURITY.md"),
  ]);
  assert.match(architecture, /Private state \(`gateway-state\.json`\) \| 6/);
  assert.match(architecture, /Private control \(CLI ↔ broker\) \| 5/);
  assert.match(architecture, /Federation \(`peer-stdio`\) \| 3/);
  assert.match(architecture, /Consumed Claude peer protocol \| 1/);
  for (const document of [readme, config, architecture, security]) {
    assert.match(document, /schema.?6/i);
    assert.match(document, /reset/i);
    assert.match(document, /(?:no|does not|without).{0,30}(?:compatibility|migrat|converter)/is);
  }
  assert.match(config, /Refusal does not mutate the installed file/i);
  assert.match(config, /Keep the valid `nodes\.json`/);
  assert.match(config, /invalidates delivery tokens and\s+conversation references/i);
});

test("configuration publishes the actual bounded core settings", async () => {
  const configuration = await read("docs/CONFIGURATION.md");
  assert.match(configuration, /\{"version":1,"host":"studio","nodes":\[\]\}/);
  assert.match(squash(configuration), /absent on the first single-machine boot.*derives a lower-case host.*atomically installs/i);
  assert.match(configuration, /present file is never\s+rewritten/i);
  const rows: ReadonlyArray<readonly [string, string, string]> = [
    ["EMBASSY_MAX_ROUTES", "128", "2–128"],
    ["EMBASSY_MAX_QUEUE_MESSAGES", "100", "1–100"],
    ["EMBASSY_MAX_QUEUE_PER_ROUTE", "20", "1–20"],
    ["EMBASSY_MAX_IN_FLIGHT", "16", "1–16"],
    ["EMBASSY_MAX_MESSAGE_BYTES", "16384", "1–16384"],
    ["EMBASSY_MAX_QUEUE_BYTES", "1048576", "1024–1048576"],
    ["EMBASSY_EVENT_CAPACITY", "500", "10–500"],
    ["EMBASSY_EVENT_TTL_MS", "86400000", "60000–604800000"],
  ];
  for (const [name, fallback, range] of rows) {
    assert.match(configuration, new RegExp("\\\\| `" + name + "` \\\\| " + fallback + " \\\\| " + range));
  }
  assert.doesNotMatch(configuration, /EMBASSY_DEDUPE_|EMBASSY_DELIVERY_NOTICES|EMBASSY_MAX_PAIRS/);
});

test("security doctrine pins identity, privacy, and uncertainty boundaries", async () => {
  const security = await read("SECURITY.md");
  assert.match(security, /^## What Embassy defends, and what it deliberately does not$/m);
  assert.match(security, /A body, alias, provider response, catalog\s+row, or persisted field cannot grant that authority by itself/i);
  assert.match(security, /opaque `\(ID, host, provider\)` tuple is routing authority/i);
  assert.match(security, /never silently rebound/i);
  assert.match(security, /Only a positive no-write result may return work to the queue/i);
  assert.match(security, /Neither is\s+replayed/i);
  assert.match(squash(security), /Native IDs or handles, socket paths, message bodies, delivery\/conversation secrets, credentials/i);
  assert.match(squash(security), /Neither is a provider readiness, model comprehension, or cross-machine proof/i);
});

test("architecture names one core and only three destination adapters", async () => {
  const architecture = await read("docs/GATEWAY-ARCHITECTURE.md");
  assert.match(architecture, /`ledger\.ts` is the pure transition core/i);
  assert.match(squash(architecture), /Provider I\/O cannot run under a transaction/i);
  assert.match(architecture, /The coordinator is the only delivery scheduler/i);
  assert.match(architecture, /^### Claude socket$/m);
  assert.match(architecture, /^### Codex operation$/m);
  assert.match(architecture, /^### SSH handoff$/m);
  assert.match(architecture, /There is no forked helper, callback socket, advertisement record/i);
  assert.match(squash(architecture), /no shell-peer registration\/token\/mailbox\/await system/i);
  assert.match(architecture, /no persisted remote route mirror/i);
  assert.match(squash(architecture), /no dashboard\/watch event system/i);
});

test("status and check are not advertised as provider readiness", async () => {
  const [readme, security, architecture, agent] = await Promise.all([
    read("README.md"), read("SECURITY.md"), read("docs/GATEWAY-ARCHITECTURE.md"),
    read(".claude/agents/content-writer.md"),
  ]);
  for (const document of [readme, security, architecture, agent]) {
    assert.match(document, /check/i);
    assert.match(squash(document), /not (?:a )?provider[- ]readiness|do not prove provider readiness|Neither is a provider readiness/i);
  }
  assert.match(readme, /each local route's last native operation/i);
});

test("federation display is an observed cache, never routing authority", async () => {
  const [readme, architecture, security] = await Promise.all([
    read("README.md"), read("docs/GATEWAY-ARCHITECTURE.md"), read("SECURITY.md"),
  ]);
  for (const document of [readme, architecture, security]) {
    const text = squash(document);
    assert.match(text, /status.*(?:performs no provider or network I\/O|reads? .* without (?:provider or )?network I\/O)/i);
    assert.match(text, /PEER_TUNNEL_UNAVAILABLE/);
    assert.match(text, /(?:named and exact|Named and exact|Routing still).*owner/i);
  }
  assert.match(squash(readme), /retains the last rows when a later refresh fails/i);
  assert.match(squash(architecture), /caps the combined remote display at 128 rows/i);
  assert.match(squash(architecture), /reporting truncation/i);
});

test("federation trusts the SSH login and configured host claim without a separate identity mode", async () => {
  const [readme, configuration, architecture, security] = await Promise.all([
    read("README.md"), read("docs/CONFIGURATION.md"), read("docs/GATEWAY-ARCHITECTURE.md"), read("SECURITY.md"),
  ]);
  assert.match(squash(readme), /plain same-user SSH login is the trust boundary/i);
  assert.match(squash(configuration), /does not require a forced command, per-node key, or special SSH environment/i);
  assert.match(squash(architecture), /initialize.host.*peer claim.*nodes.json.*does not bind it independently/i);
  assert.match(squash(security), /one same-user trust domain/i);
  assert.match(squash(security), /copied `nodes.json`.*wrong allowed `host`.*misattribute/i);
  for (const document of [readme, configuration, architecture, security]) {
    assert.doesNotMatch(squash(document), /validates the authenticated peer host|source owner attests|SSH authenticates the remote machine/i);
  }
});

test("setup form asks about the v4 native and federation paths", async () => {
  const issue = await read(".github/ISSUE_TEMPLATE/setup_help.yml");
  for (const phrase of [
    "embassy send --to (sending by name)",
    "embassy send --conversation (answering)",
    "Native delivery waking Claude Code",
    "Native delivery waking a Codex task",
    "SSH federation / embassy peer-stdio",
    "embassy check (broker-only loopback)",
  ]) assert.match(issue, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(issue, /register-peer|peer-\* peer|ListAgents|SendMessage/);
});

test("current public docs contain no personal absolute path", async () => {
  for (const file of currentDocs) {
    const document = await read(file);
    assert.doesNotMatch(document, /\/(?:Users|home)\/[A-Za-z0-9._-]+\//, file);
  }
});

test("relative Markdown links in the current guides resolve", async () => {
  for (const file of ["README.md", "SECURITY.md", "CONTRIBUTING.md", "docs/CONFIGURATION.md", "docs/DELIVERY.md", "docs/GATEWAY-ARCHITECTURE.md"]) {
    const document = await read(file);
    for (const match of document.matchAll(/\[[^\]]+\]\((?!https?:|#)([^)#]+)(?:#[^)]+)?\)/g)) {
      const target = path.resolve(path.dirname(path.join(root, file)), match[1]!);
      assert.ok((await stat(target)).isFile(), `${file} links to missing ${match[1]}`);
    }
  }
});

test("packaged documentation roots exist", async () => {
  const pkg = JSON.parse(await read("package.json")) as { files: string[] };
  for (const file of ["README.md", "SECURITY.md", "CONTRIBUTING.md", "docs/CONFIGURATION.md", "docs/DELIVERY.md", "docs/GATEWAY-ARCHITECTURE.md"]) {
    assert.ok(pkg.files.includes(file) || pkg.files.includes(path.dirname(file)), `${file} is not packaged`);
  }
});
