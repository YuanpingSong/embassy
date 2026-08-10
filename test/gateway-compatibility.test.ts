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

test("compatibility admission accepts only the exact certified inventory", () => {
  const base = {
    surface: "claude" as const,
    checkedAt: "2026-08-09T12:00:00.000Z",
    certifiedVersions: ["2.1.226"],
    probes: passing("claude"),
  };
  const certified = evaluateCompatibilityAttestation({
    ...base,
    version: "2.1.226",
  });
  assert.equal(certified.tier, "certified");
  assert.equal(certified.safeErrorCode, undefined);
  assert.equal(isCompatibilityAttestation(certified), true);

  for (const version of ["2.2.0", "3.0.0"] as const) {
    const result = evaluateCompatibilityAttestation({
      ...base,
      version,
    });
    assert.equal(result.tier, "incompatible");
    assert.equal(result.safeErrorCode, "CLAUDE_VERSION_DRIFT");
    assert.equal(compatibilityCacheKey(result), `claude\0${version}`);
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
        certifiedVersions: ["0.147.0"],
        probes: passing("codex").slice(1),
      }),
    { message: /exact ordered surface probe set/ },
  );
  const codexDrift = evaluateCompatibilityAttestation({
    surface: "codex",
    version: "1.0.0",
    checkedAt: "2026-08-09T12:00:00.000Z",
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
