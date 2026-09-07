import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runCoreCli } from "../src/gateway/core-cli.js";
import { Writable } from "node:stream";

test("packaged skill describes native-receive, identity-inferred v4 operations", async () => {
  const skill = await readFile(new URL("../skills/embassy-peer/SKILL.md", import.meta.url), "utf8");
  const metadata = await readFile(new URL("../skills/embassy-peer/agents/openai.yaml", import.meta.url), "utf8");
  assert.match(skill, /^---\nname: embassy-peer\ndescription: .+\n---\n/);
  assert.match(skill, /The operator runs `embassy skills install` to install or update the packaged `embassy-peer` skill/);
  assert.match(skill, /The agent must not install or copy skills, or modify provider configuration\./);
  assert.match(skill, /Receiving is native/);
  assert.match(skill, /Do not resend an ambiguous or unconfirmed delivery/);
  assert.match(skill, /Reply references survive a broker restart/);
  assert.match(metadata, /\$embassy-peer/);
  assert.match(metadata, /short_description: ".{25,64}"/);
  let help = "";
  await runCoreCli(["--help"], { stdout: new Writable({ write(chunk, _encoding, done) { help += chunk; done(); } }) });
  for (const block of skill.matchAll(/```sh\n([\s\S]*?)```/g)) {
    const line = block[1]!.trim().split("\n")[0]!;
    const verb = /^embassy ([a-z-]+)/.exec(line)?.[1];
    assert.ok(verb && help.includes(`embassy ${verb}`), line);
    assert.doesNotMatch(line, /--from|--token-stdin|embassy (?:reply|await|register-peer|unregister-codex)\b/);
  }
});
