import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { runCoreSkillsCommand } from "../src/gateway/core-skills-command.js";

const cli = fileURLToPath(new URL("../dist/src/gateway/core-cli.js", import.meta.url));
const packaged = fileURLToPath(new URL("../skills/embassy-peer/", import.meta.url));

async function fixture(t: TestContext) {
  const home = await mkdtemp(path.join(await realpath(os.tmpdir()), "emb-skills-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const target = (provider: string) => path.join(home, `.${provider}`, "skills", "embassy-peer");
  const run = (...args: string[]) => new Promise<{ code: number; stdout: string; stderr: string; json: any }>((resolve, reject) => {
    // Real compiled CLI, no loader/control/provider stubs; no npm on PATH or valid broker inventory.
    execFile(process.execPath, [cli, "skills", ...args], { cwd: home, env: {
      ...process.env, HOME: home, PATH: home, EMBASSY_STATE_DIR: path.join(home, "no-broker"),
      CODEX_THREAD_ID: "fixture-codex", CLAUDE_CODE_MESSAGING_SOCKET: "/fixture/claude.sock",
    } }, (error, stdout, stderr) => {
      if (error && typeof error.code !== "number") { reject(error); return; }
      try {
        assert.equal(stdout.trim().split("\n").length, 1);
        resolve({ code: error && typeof error.code === "number" ? error.code : 0, stdout, stderr, json: JSON.parse(stdout) });
      } catch (failure) { reject(failure); }
    });
  });
  return { home, target, run };
}

test("unwrapped skills CLI installs its own package, reports current, leaves identical bytes untouched and repairs stale copies", async (t) => {
  const f = await fixture(t);
  assert.deepEqual((await f.run("status")).json, { ok: true, command: "skills", result: {
    subcommand: "status", targets: ["claude", "codex"].map(provider => ({ provider, path: f.target(provider), status: "absent" })),
  } });
  assert.deepEqual(await readdir(f.home), []);
  const installed = await f.run("install");
  assert.equal(installed.code, 0);
  assert.equal(installed.stderr, "");
  assert.deepEqual(installed.json.result.targets, ["claude", "codex"].map(provider => ({ provider, path: f.target(provider), status: "installed" })));
  for (const provider of ["claude", "codex"]) {
    for (const relative of ["SKILL.md", "agents/openai.yaml"]) {
      assert.deepEqual(await readFile(path.join(f.target(provider), relative)), await readFile(path.join(packaged, relative)));
    }
  }
  assert.deepEqual((await f.run("status")).json.result.targets.map((x: any) => x.status), ["current", "current"]);
  const skill = path.join(f.target("claude"), "SKILL.md");
  const before = await lstat(skill);
  assert.deepEqual((await f.run("install")).json.result.targets.map((x: any) => x.status), ["unchanged", "unchanged"]);
  const after = await lstat(skill);
  assert.equal(after.ino, before.ino);
  assert.equal(after.mtimeMs, before.mtimeMs);
  await writeFile(skill, "locally changed");
  await writeFile(path.join(f.target("claude"), "local-note.txt"), "preserve me");
  assert.deepEqual((await f.run("status")).json.result.targets.map((x: any) => x.status), ["stale", "current"]);
  assert.deepEqual((await f.run("install")).json.result.targets.map((x: any) => x.status), ["updated", "unchanged"]);
  assert.deepEqual(await readFile(skill), await readFile(path.join(packaged, "SKILL.md")));
  assert.equal(await readFile(path.join(f.target("claude"), "local-note.txt"), "utf8"), "preserve me");
  await rm(path.join(f.target("codex"), "agents", "openai.yaml"));
  assert.equal((await f.run("status", "--codex-only")).json.result.targets[0].status, "stale");
  assert.equal((await f.run("install", "--codex-only")).json.result.targets[0].status, "updated");
  assert.deepEqual(await readFile(path.join(f.target("codex"), "agents", "openai.yaml")), await readFile(path.join(packaged, "agents", "openai.yaml")));
  assert.equal(await lstat(path.join(f.home, "no-broker")).catch(() => undefined), undefined);
});

test("provider flags limit both status and installation, including directory creation", async (t) => {
  for (const provider of ["claude", "codex"]) {
    const f = await fixture(t);
    const flag = `--${provider}-only`;
    assert.deepEqual((await f.run("status", flag)).json.result.targets, [{ provider, path: f.target(provider), status: "absent" }]);
    assert.deepEqual((await f.run("install", flag)).json.result.targets, [{ provider, path: f.target(provider), status: "installed" }]);
    assert.deepEqual(await readdir(f.home), [`.${provider}`]);
  }
});

test("skills rejects invalid arguments before creating any directories", async (t) => {
  const f = await fixture(t);
  for (const args of [[], ["remove"], ["install", "--force"], ["install", "--claude-only", "--codex-only"], ["status", "--codex-only", "--codex-only"]]) {
    const result = await f.run(...args);
    assert.equal(result.code, 2);
    assert.deepEqual(result.json, { ok: false, command: "skills", error: { code: "INVALID_ARGUMENTS" } });
  }
  assert.deepEqual(await readdir(f.home), []);
});

test("symlink or non-directory targets refuse before the other selected target is written", async (t) => {
  for (const kind of ["link", "file"] as const) {
    const f = await fixture(t);
    const outside = path.join(f.home, "outside");
    await mkdir(outside);
    await writeFile(path.join(outside, "SKILL.md"), "untouched");
    await mkdir(path.dirname(f.target("codex")), { recursive: true });
    if (kind === "link") await symlink(outside, f.target("codex"));
    else await writeFile(f.target("codex"), "not a directory");
    for (const verb of ["install", "status"]) {
      const result = await f.run(verb);
      assert.equal(result.code, 3);
      assert.equal(result.json.error.code, "SKILLS_TARGET_UNSAFE");
      assert.match(result.stderr, /Do not use sudo/);
    }
    assert.equal(await lstat(path.join(f.home, ".claude")).catch(() => undefined), undefined);
    assert.equal(await readFile(path.join(outside, "SKILL.md"), "utf8"), "untouched");
  }
});

test("used parent and packaged child symlinks refuse; unrelated extra files are outside the copy", async (t) => {
  const f = await fixture(t);
  await mkdir(path.join(f.home, "outside"));
  await symlink(path.join(f.home, "outside"), path.join(f.home, ".claude"));
  assert.equal((await f.run("install", "--claude-only")).json.error.code, "SKILLS_TARGET_UNSAFE");
  await rm(path.join(f.home, ".claude"));
  await f.run("install");
  const child = path.join(f.target("claude"), "SKILL.md");
  await rm(child);
  await symlink(path.join(packaged, "SKILL.md"), child);
  assert.equal((await f.run("install")).json.error.code, "SKILLS_TARGET_UNSAFE");
});

test("ownership refusal uses filesystem uid evidence; missing packaged skill refuses without mutation", async (t) => {
  const f = await fixture(t);
  // Inject only the expected uid: the lstat evidence is real; no chown or privileged fixture.
  await assert.rejects(runCoreSkillsCommand("install", ["claude"], { HOME: f.home }, { uid: process.getuid!() + 1 }), { code: "SKILLS_TARGET_UNSAFE" });
  await assert.rejects(runCoreSkillsCommand("install", ["claude"], { HOME: f.home }, { sourceDir: f.home }), { code: "SKILLS_PACKAGE_INVALID" });
  assert.deepEqual(await readdir(f.home), []);
});
