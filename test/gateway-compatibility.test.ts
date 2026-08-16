import assert from "node:assert/strict";
import { test } from "node:test";

import {
  compatibilitySurfaces,
  isCompatibilityVersion,
  isCompatibilityVersionEvidence,
  UNKNOWN_COMPATIBILITY_VERSION,
  type CompatibilityProbeResult,
  type CompatibilitySurfaceObserver,
} from "../src/gateway/compatibility.js";

test("compatibility version evidence is bounded and informational", () => {
  assert.deepEqual(compatibilitySurfaces, ["claude", "codex", "deepseek"]);
  assert.equal(Object.isFrozen(compatibilitySurfaces), true);
  for (const version of [
    "2.2.0",
    "2.2.0-rc",
    "2.2.0-rc.1",
    "0.147.1-dev-20260816",
  ]) {
    assert.equal(isCompatibilityVersion(version), true);
    assert.equal(isCompatibilityVersionEvidence(version), true);
  }
  for (const version of [
    "2.2.0-",
    "2.2.0-rc..1",
    "2.2.0-01",
    "2.2.0+build",
    `2.2.0-${"a".repeat(129)}`,
  ]) {
    assert.equal(isCompatibilityVersion(version), false);
    assert.equal(isCompatibilityVersionEvidence(version), false);
  }
  assert.equal(
    isCompatibilityVersionEvidence(UNKNOWN_COMPATIBILITY_VERSION),
    true,
  );
});

test("the temporary DeepSeek observer remains read-only", async () => {
  const probes: readonly CompatibilityProbeResult[] = [
    { name: "installation", outcome: "pass" },
    { name: "harness_home", outcome: "pass" },
    { name: "version", outcome: "fail", safeErrorCode: "VERSION_FAILED" },
  ];
  const observer: CompatibilitySurfaceObserver = {
    compatibilitySurface: () => ({ surface: "deepseek", version: "1.0.0" }),
    runCompatibilityProbes: async () => probes,
  };

  assert.deepEqual(observer.compatibilitySurface(), {
    surface: "deepseek",
    version: "1.0.0",
  });
  assert.deepEqual(await observer.runCompatibilityProbes(), probes);
});
