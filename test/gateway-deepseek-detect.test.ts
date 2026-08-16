import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { resolveDeepSeekAcpLaunch } from "../src/gateway/deepseek-detect.js";

test("an absent DeepSeek checkout is an honest provider-local absence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "embassy-dsh-absent-"));
  try {
    assert.deepEqual(await resolveDeepSeekAcpLaunch({
      env: {},
      loginHome: root,
    }), { safeErrorCode: "DEEPSEEK_HARNESS_HOME_UNAVAILABLE" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the attested harness root yields only the documented checkout launch", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "embassy-dsh-present-"));
  const checkout = path.join(root, "checkout");
  const secret = "DEEPSEEK_CREDENTIAL_SENTINEL";
  await mkdir(checkout, { mode: 0o700 });
  await writeFile(path.join(checkout, "package.json"), "{}", { mode: 0o600 });
  await writeFile(path.join(checkout, ".credentials.yaml"), secret, { mode: 0o600 });
  try {
    const resolved = await resolveDeepSeekAcpLaunch({
      env: { DSH_HOME: checkout, DEEPSEEK_API_KEY: secret },
      loginHome: root,
    });
    assert.deepEqual(resolved, {
      launch: {
        kind: "local-checkout",
        command: "pnpm",
        args: ["--dir", checkout, "run", "demo:acp"],
        cwd: checkout,
      },
    });
    assert.equal(JSON.stringify(resolved).includes(secret), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unsafe checkout evidence degrades without throwing", async () => {
  const result = await resolveDeepSeekAcpLaunch({
    env: { DSH_HOME: "/synthetic/checkout" },
    loginHome: "/synthetic",
    lstat: async () => {
      throw Object.assign(new Error("denied"), { code: "EACCES" });
    },
  });
  assert.deepEqual(result, { safeErrorCode: "DEEPSEEK_HARNESS_HOME_UNSAFE" });
});
