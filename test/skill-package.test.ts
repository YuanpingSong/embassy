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

test("repo-shipped peer skill has complete discoverable metadata", async () => {
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
  assert.match(interfaceYaml, /shell peers safely/);
  assert.match(interfaceYaml, /register this task or shell peer, await inbound mail/);
});

test("skill exposes only the stable gateway operating surface", async () => {
  const skill = await readSkill();
  const commands = [
    "health",
    "serve",
    "status",
    "refresh",
    "register-codex",
    "unregister-codex",
    "send",
    "reply",
  ];

  for (const command of commands) {
    assert.match(skill, new RegExp(`embassy ${command}\\b`));
  }

  assert.match(skill, /name@host/);
  assert.match(skill, /ListAgents.*`codex-\*` or `peer-\*`/);
  assert.match(skill, /availablePeers/);
  assert.match(skill, /exact prefix `STEER:`/);
  assert.match(skill, /next tool-call boundary/);
  assert.match(skill, /cap is three steers per exact active operation/);
  assert.match(skill, /standard input/);
  assert.match(skill, /native bidirectional messaging/);
  assert.match(skill, /codex-\*/);
  assert.doesNotMatch(skill, /embassy send-to-(?:claude|codex)\b/);
  assert.doesNotMatch(skill, /--(?:text|message|body)\b/);
});

test("skill preserves transient identities and limits native advertisement", async () => {
  const skill = await readSkill();

  assert.match(skill, /CODEX_THREAD_ID/);
  assert.match(skill, /CLAUDE_CODE_MESSAGING_SOCKET/);
  assert.match(skill, /never echo it/i);
  assert.match(skill, /Publish only.*non-Claude route \(`codex-\*` or `peer-\*`\)/);
  assert.match(skill, /Do not automatically retry/);
  assert.match(skill, /user-supplied native session UUID/);
  assert.match(skill, /old name stops resolving immediately/);
  assert.match(skill, /installs a discovered Claude session's route on its first use/);
  assert.match(skill, /PEER_ALIAS_COLLISION/);
  assert.match(skill, /crossSessionInbound/);
  assert.match(skill, /Claude, Codex, and shell peers as first-class providers/);
  assert.match(skill, /register-peer --alias peer-reviewer@your-host/);
  assert.match(skill, /first\s+stdin line is the exact token/);
  assert.match(skill, /never the token/);
  assert.match(skill, /There is no PID binding or helper daemon/);
  assert.match(skill, /bounded 30-second long polls/);
  assert.match(skill, /broker allows 16 globally/);
  assert.match(skill, /Runtime status is best-effort/);
  assert.match(skill, /observation freshness, connector health, observed metadata, and the last safe code/);
  assert.match(skill, /versions are diagnostic metadata, not routing authority/);
  // No shipped file may claim that a matrix or the CHANGELOG records tested versions.
  assert.doesNotMatch(skill, /tested versions are listed|support matrix|CHANGELOG records|CHANGELOG lists/i);
  assert.match(skill, /no separate grant to create or revoke/);
  assert.match(skill, /same-UID private control socket/);
  assert.match(skill, /Registration commits only the logical route record and performs no provider or App Server I\/O/);
  assert.match(skill, /Every Codex operation independently attests the current interface and resumes the exact registered task/);
  assert.match(skill, /bounded observation is display-only and never routing authority or a dispatch gate/);
  assert.doesNotMatch(skill, /schema_attested|monitor-only|write-attestation/i);
  assert.match(skill, /accepts any compatible live Claude session running as the same OS user/);
  assert.match(skill, /CALLER_IDENTITY_CONFLICT/);
  assert.match(skill, /env -u CLAUDE_CODE_MESSAGING_SOCKET/);
  assert.match(skill, /env -u CODEX_THREAD_ID/);
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
