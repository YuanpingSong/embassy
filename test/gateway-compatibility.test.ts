import assert from "node:assert/strict";
import { test } from "node:test";

import {
  compatibilityCacheKey,
  compatibilityProbeNames,
  evaluateCompatibilityAttestation,
  isCompatibilityAttestation,
  type CompatibilityProbeResult,
  type CompatibilitySurface,
} from "../src/gateway/compatibility.js";

function passing(surface: CompatibilitySurface): CompatibilityProbeResult[] {
  return compatibilityProbeNames[surface].map((name) => ({
    name,
    outcome: "pass",
  }));
}

test("compatibility tiers distinguish certified, observed, strict, and major drift", () => {
  const base = {
    surface: "claude" as const,
    checkedAt: "2026-08-09T12:00:00.000Z",
    certifiedVersions: ["2.1.226"],
    probes: passing("claude"),
  };
  const certified = evaluateCompatibilityAttestation({
    ...base,
    version: "2.1.226",
    policy: "observed",
  });
  assert.equal(certified.tier, "certified");
  assert.equal(certified.safeErrorCode, undefined);
  assert.equal(isCompatibilityAttestation(certified), true);

  const observed = evaluateCompatibilityAttestation({
    ...base,
    version: "2.2.0",
    policy: "observed",
  });
  assert.equal(observed.tier, "schema_attested");
  assert.equal(compatibilityCacheKey(observed), "claude\0" + "2.2.0");

  for (const [version, policy] of [
    ["2.2.0", "strict"],
    ["3.0.0", "observed"],
  ] as const) {
    const result = evaluateCompatibilityAttestation({
      ...base,
      version,
      policy,
    });
    assert.equal(result.tier, "incompatible");
    assert.equal(result.safeErrorCode, "CLAUDE_VERSION_DRIFT");
  }
});

test("one failed bounded probe fails closed and malformed evidence is rejected", () => {
  const probes = passing("codex");
  probes[2] = {
    name: "initialize",
    outcome: "fail",
    safeErrorCode: "CODEX_INITIALIZE_SCHEMA_INVALID",
  };
  const failed = evaluateCompatibilityAttestation({
    surface: "codex",
    version: "0.148.0",
    checkedAt: "2026-08-09T12:00:00.000Z",
    policy: "observed",
    certifiedVersions: ["0.147.0"],
    probes,
  });
  assert.equal(failed.tier, "incompatible");
  assert.equal(failed.safeErrorCode, "CODEX_INITIALIZE_SCHEMA_INVALID");
  assert.equal(isCompatibilityAttestation(failed), true);
  assert.equal(
    isCompatibilityAttestation({ ...failed, probes: [...failed.probes].reverse() }),
    false,
  );
  assert.throws(
    () =>
      evaluateCompatibilityAttestation({
        surface: "codex",
        version: "0.148.0",
        checkedAt: "2026-08-09T12:00:00.000Z",
        policy: "observed",
        certifiedVersions: ["0.147.0"],
        probes: passing("codex").slice(1),
      }),
    { message: /exact ordered surface probe set/ },
  );
  const codexDrift = evaluateCompatibilityAttestation({
    surface: "codex",
    version: "1.0.0",
    checkedAt: "2026-08-09T12:00:00.000Z",
    policy: "observed",
    certifiedVersions: ["0.147.0"],
    probes: passing("codex"),
  });
  assert.equal(codexDrift.safeErrorCode, "CODEX_VERSION_DRIFT");
  assert.equal(isCompatibilityAttestation(codexDrift), true);
  assert.equal(
    isCompatibilityAttestation({
      ...codexDrift,
      safeErrorCode: "CLAUDE_VERSION_DRIFT",
    }),
    false,
  );
});
