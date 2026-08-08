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
  assert.match(skill, /v1 busy policy is queue-only/);
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
  assert.match(skill, /Publish only.*selected `codex-\*` peer record/);
  assert.match(skill, /Do not automatically retry/);
  assert.match(skill, /user-supplied native session UUID/);
  assert.match(skill, /select-claude --session/);
  assert.match(skill, /old name stops resolving immediately/);
  assert.match(skill, /send never selects a Claude session automatically/i);
  assert.match(skill, /crossSessionInbound/);
  assert.match(skill, /Every exact live same-UID Claude session/);

  assert.doesNotMatch(skill, /~\/.claude|\/tmp\/cc-socks|\.claude\/sessions/);
  assert.doesNotMatch(skill, /\b(?:printenv|set)\b/);
  assert.doesNotMatch(skill, /\bclaude\s+(?:-p|--print)\b/);
  assert.doesNotMatch(skill, /--(?:target-id|session-id|pid|socket(?:-path)?)\b/);
  assert.doesNotMatch(skill, /(?:echo|printf)[^\n]*(?:CODEX_THREAD_ID|CLAUDE_CODE_MESSAGING_SOCKET)/);
});
