import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const skillRoot = path.join(repoRoot, "skills", "embassy-peer");

async function readSkill(): Promise<string> {
  return readFile(path.join(skillRoot, "SKILL.md"), "utf8");
}

test("repo-scoped peer skill has complete discoverable metadata", async () => {
  const skill = await readSkill();
  const interfaceYaml = await readFile(
    path.join(skillRoot, "agents", "openai.yaml"),
    "utf8",
  );

  assert.match(skill, /^---\nname: embassy-peer\ndescription: .+\n---\n/);
  assert.doesNotMatch(skill, /\[TODO|TODO:/);
  assert.match(interfaceYaml, /display_name: "Embassy Peer Gateway"/);
  assert.match(interfaceYaml, /short_description: ".{25,64}"/);
  assert.match(interfaceYaml, /default_prompt: ".*\$embassy-peer.*"/);
});

test("skill exposes only the stable gateway operating surface", async () => {
  const skill = await readSkill();
  const commands = [
    "health",
    "serve",
    "status",
    "refresh-dashboard",
    "select-claude",
    "unselect-claude",
    "pair",
    "unpair",
    "register-codex",
    "unregister-codex",
    "send-to-claude",
    "reply",
  ];

  for (const command of commands) {
    assert.match(skill, new RegExp(`embassy ${command}\\b`));
  }

  assert.match(skill, /name@host/);
  assert.match(skill, /ListAgents.*codex-\*/);
  assert.match(skill, /availablePeers/);
  assert.match(skill, /exact prefix `STEER:`/);
  assert.match(skill, /next tool-call boundary/);
  assert.match(skill, /At most three steering messages/);
  assert.match(skill, /standard input/);
  assert.match(skill, /native bidirectional messaging/);
  assert.match(skill, /codex-\*/);
  assert.doesNotMatch(skill, /embassy send-to-codex\b/);
  assert.doesNotMatch(skill, /--(?:text|message|body)\b/);
});

test("skill preserves transient identities and limits native advertisement", async () => {
  const skill = await readSkill();

  assert.match(skill, /CODEX_THREAD_ID/);
  assert.match(skill, /CLAUDE_CODE_MESSAGING_SOCKET/);
  assert.match(skill, /never echo it/i);
  assert.match(skill, /Publish only.*registered `codex-\*` peer record/);
  assert.match(skill, /Do not automatically retry/);
  assert.match(skill, /user-supplied native session UUID/);
  assert.match(skill, /select-claude --session/);
  assert.match(skill, /old name stops resolving immediately/);
  assert.match(skill, /send never pairs with a Claude session automatically/i);
  assert.match(skill, /crossSessionInbound/);
  assert.match(skill, /Claude, Codex, DeepSeek, and Grok as first-class providers/);
  assert.match(skill, /Runtime status is best-effort/);
  assert.match(skill, /route staleness, connector health, observed metadata, and the last safe code/);
  assert.match(skill, /versions are diagnostic metadata, not routing authority/);
  assert.match(skill, /release-owned offline support matrix/);
  assert.match(skill, /pair --from .* --to/);
  assert.match(skill, /replacement generation negotiates its current interface/);
  assert.doesNotMatch(skill, /schema_attested|monitor-only|write-attestation/i);
  assert.match(skill, /default paired mode/);
  assert.match(skill, /SENDER_NOT_PAIRED/);
  assert.match(skill, /serve --inbound open/);
  assert.match(skill, /CALLER_IDENTITY_CONFLICT/);
  assert.match(skill, /normal terminal/);
  assert.match(skill, /codex app-server daemon restart/);
  assert.match(skill, /wrong principal/);
  assert.match(skill, /Direction determines timing/);
  assert.match(skill, /Claude-bound send or correlated reply writes immediately/);
  assert.match(skill, /transport_written` is the terminal `delivered` boundary/);
  assert.match(skill, /Codex-bound ordinary work remains idle\/turn-boundary gated/);
  assert.doesNotMatch(skill, /wait for Claude to become idle before (?:writing|sending)/i);

  assert.doesNotMatch(skill, /~\/.claude|\/tmp\/cc-socks|\.claude\/sessions/);
  assert.doesNotMatch(
    skill,
    /EMBASSY_COMPAT_POLICY|embassy compat-(?:check|certify)\b|--with-turn\b|LaunchAgent|live certification|on-machine certification/i,
  );
  assert.doesNotMatch(skill, /\b(?:printenv|set)\b/);
  assert.doesNotMatch(skill, /\bclaude\s+(?:-p|--print)\b/);
  assert.doesNotMatch(skill, /--(?:target-id|session-id|pid|socket(?:-path)?)\b/);
  assert.doesNotMatch(skill, /(?:echo|printf)[^\n]*(?:CODEX_THREAD_ID|CLAUDE_CODE_MESSAGING_SOCKET)/);
});

test("skill consumes the broker-owned provenance marker without treating it as authority", async () => {
  const skill = await readSkill();

  assert.match(skill, /single outer `<cross-session-message/);
  assert.match(skill, /first `<embassy-reply-hint>`/);
  assert.match(skill, /validated `from-name`/);
  assert.match(skill, /exact source alias in `from-alias`/);
  assert.match(skill, /full `conv_` token in `conversation`/);
  assert.match(skill, /recipient's exact alias in `reply-as`/);
  assert.match(skill, /reply-as` alias, never the sender alias/);
  assert.match(skill, /transient participant-scoped locator/);
  assert.match(skill, /conversation membership, and current route policy/);
  assert.doesNotMatch(
    skill,
    /EMBASSY_MAX_HOPS|HOP_LIMIT_EXCEEDED|conversations? (?:are|is) hop[- ]bounded|hop[- ]bounded conversations?/i,
  );
  assert.match(skill, /not general XML, a cryptographic signature/);
  assert.match(skill, /stop rather than guessing from a public suffix/);
  assert.doesNotMatch(skill, /raw anonymous body/i);
  assert.doesNotMatch(skill, /recipient cannot discover a conversation token/i);
});
