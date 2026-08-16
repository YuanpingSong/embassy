import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { UNKNOWN_COMPATIBILITY_VERSION } from "../src/gateway/compatibility.js";
import { detectDeepSeekSurface } from "../src/gateway/deepseek-detect.js";

test("absent DeepSeek costs no version spawn", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "embassy-dsh-absent-"));
  let spawns = 0;
  try {
    assert.equal(
      await detectDeepSeekSurface({
        env: { PATH: root },
        loginHome: root,
        runVersion: async () => {
          spawns += 1;
          return "0.1.0";
        },
      }),
      undefined,
    );
    assert.equal(spawns, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("DeepSeek prerelease evidence is bounded, quarantined, and credential-free", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "embassy-dsh-present-"));
  const bin = path.join(root, "bin");
  const home = path.join(root, ".dsh");
  const executable = path.join(bin, "dsh");
  const secret = "DEEPSEEK_SECRET_MUST_NOT_CROSS_PROBE";
  await mkdir(bin, { mode: 0o700 });
  await mkdir(home, { mode: 0o700 });
  await writeFile(executable, "synthetic", { mode: 0o700 });
  await chmod(executable, 0o700);
  await writeFile(path.join(home, ".credentials.yaml"), secret, { mode: 0o600 });
  let observedEnv: NodeJS.ProcessEnv | undefined;
  try {
    const detected = await detectDeepSeekSurface({
      env: { PATH: bin, DSH_HOME: home, DEEPSEEK_API_KEY: secret },
      loginHome: root,
      runVersion: async (received, env) => {
        assert.equal(received, executable);
        observedEnv = env;
        return "dsh 0.1.0-rc.6";
      },
    });
    assert.notEqual(detected, undefined);
    assert.deepEqual(detected!.compatibilitySurface(), {
      surface: "deepseek",
      version: UNKNOWN_COMPATIBILITY_VERSION,
    });
    assert.deepEqual(await detected!.runCompatibilityProbes(), [
      { name: "installation", outcome: "pass" },
      { name: "harness_home", outcome: "pass" },
      {
        name: "version",
        outcome: "fail",
        safeErrorCode: "DEEPSEEK_HARNESS_VERSION_UNPARSEABLE",
      },
    ]);
    assert.equal(observedEnv?.DEEPSEEK_API_KEY, undefined);
    assert.equal(JSON.stringify(observedEnv).includes(secret), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an unsafe DeepSeek home prevents the version spawn", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "embassy-dsh-unsafe-"));
  const bin = path.join(root, "bin");
  const executable = path.join(bin, "dsh");
  await mkdir(bin, { mode: 0o700 });
  await writeFile(executable, "synthetic", { mode: 0o700 });
  let spawns = 0;
  try {
    const detected = await detectDeepSeekSurface({
      env: { PATH: bin, DSH_HOME: path.join(root, "missing") },
      loginHome: root,
      runVersion: async () => {
        spawns += 1;
        return "0.1.0";
      },
    });
    assert.equal(spawns, 0);
    assert.equal((await detected!.runCompatibilityProbes())[1]?.safeErrorCode,
      "DEEPSEEK_HARNESS_HOME_UNSAFE");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
