import assert from "node:assert/strict";
import { test } from "node:test";

import {
  compatibilityCacheKey,
  compatibilityProbeNames,
  evaluateCompatibilityAttestation,
  isCompatibilityAttestation,
  isPersistedCompatibilityAttestation,
  UNKNOWN_COMPATIBILITY_VERSION,
  type CompatibilityProbeResult,
  type CompatibilitySurface,
} from "../src/gateway/compatibility.js";

function passing(surface: CompatibilitySurface): CompatibilityProbeResult[] {
  return compatibilityProbeNames[surface].map((name) => ({
    name,
    outcome: "pass",
  }));
}

test("compatibility admission trusts only passing same-major probes beyond the certified inventory", () => {
  const base = {
    surface: "claude" as const,
    checkedAt: "2026-08-09T12:00:00.000Z",
    certifiedVersions: ["2.1.227"],
    probes: passing("claude"),
  };
  const certified = evaluateCompatibilityAttestation({
    ...base,
    version: "2.1.227",
  });
  assert.equal(certified.tier, "certified");
  assert.equal(certified.safeErrorCode, undefined);
  assert.equal(isCompatibilityAttestation(certified), true);

  const sameMajor = evaluateCompatibilityAttestation({
    ...base,
    version: "2.2.0",
  });
  assert.equal(sameMajor.tier, "schema_attested");
  assert.equal(sameMajor.safeErrorCode, undefined);
  assert.equal(isCompatibilityAttestation(sameMajor), true);
  assert.equal(compatibilityCacheKey(sameMajor), `claude\0${"2.2.0"}`);
  assert.equal(
    isCompatibilityAttestation({
      ...sameMajor,
      tier: "incompatible",
    }),
    false,
  );

  for (const [version, safeErrorCode] of [
    ["3.0.0", "CLAUDE_PEER_VERSION_UNSUPPORTED"],
    [UNKNOWN_COMPATIBILITY_VERSION, "CLAUDE_VERSION_UNPARSEABLE"],
  ] as const) {
    const result = evaluateCompatibilityAttestation({ ...base, version });
    assert.equal(result.tier, "incompatible");
    assert.equal(result.safeErrorCode, safeErrorCode);
    assert.equal(isCompatibilityAttestation(result), true);
    assert.equal(compatibilityCacheKey(result), `claude\0${version}`);
  }
});

test("persisted compatibility evidence is release-invariant but remains strict", () => {
  const checkedAt = "2026-08-09T12:00:00.000Z";
  const certifiedByEarlierRelease = evaluateCompatibilityAttestation({
    surface: "claude",
    version: "2.1.226",
    checkedAt,
    certifiedVersions: ["2.1.226"],
    probes: passing("claude"),
  });
  const certifiedByLaterRelease = evaluateCompatibilityAttestation({
    surface: "claude",
    version: "2.1.227",
    checkedAt,
    certifiedVersions: ["2.1.226"],
    probes: passing("claude"),
  });

  assert.equal(isCompatibilityAttestation(certifiedByEarlierRelease), false);
  assert.equal(isCompatibilityAttestation(certifiedByLaterRelease), false);
  assert.equal(
    isPersistedCompatibilityAttestation(certifiedByEarlierRelease),
    true,
  );
  assert.equal(
    isPersistedCompatibilityAttestation(certifiedByLaterRelease),
    true,
  );
  const historicalProbeSchema = {
    ...certifiedByEarlierRelease,
    probes: certifiedByEarlierRelease.probes.map((probe, index) =>
      index === 0 ? { ...probe, name: "launcher_v0" } : probe,
    ),
  };
  assert.equal(isCompatibilityAttestation(historicalProbeSchema), false);
  assert.equal(
    isPersistedCompatibilityAttestation(historicalProbeSchema),
    true,
  );
  const historicalFailureCode = {
    ...historicalProbeSchema,
    tier: "incompatible" as const,
    safeErrorCode: "FUTURE_MAJOR_UNSUPPORTED",
  };
  assert.equal(isCompatibilityAttestation(historicalFailureCode), false);
  assert.equal(
    isPersistedCompatibilityAttestation(historicalFailureCode),
    true,
  );
  assert.equal(
    isCompatibilityAttestation({
      ...certifiedByEarlierRelease,
      probes: [...certifiedByEarlierRelease.probes].reverse(),
    }),
    false,
  );
  assert.equal(
    isPersistedCompatibilityAttestation({
      ...certifiedByEarlierRelease,
      probes: [...certifiedByEarlierRelease.probes].reverse(),
    }),
    true,
  );
  assert.equal(
    isPersistedCompatibilityAttestation({
      ...historicalProbeSchema,
      probes: [
        ...historicalProbeSchema.probes,
        { ...historicalProbeSchema.probes[0] },
      ],
    }),
    false,
  );
  assert.equal(
    isPersistedCompatibilityAttestation({
      ...certifiedByLaterRelease,
      version: UNKNOWN_COMPATIBILITY_VERSION,
    }),
    false,
  );
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
  const codexUnsupported = evaluateCompatibilityAttestation({
    surface: "codex",
    version: "1.0.0",
    checkedAt: "2026-08-09T12:00:00.000Z",
    certifiedVersions: ["0.147.0"],
    probes: passing("codex"),
  });
  assert.equal(codexUnsupported.tier, "incompatible");
  assert.equal(
    codexUnsupported.safeErrorCode,
    "CODEX_APP_SERVER_VERSION_UNSUPPORTED",
  );
  assert.equal(isCompatibilityAttestation(codexUnsupported), true);
  assert.equal(
    isCompatibilityAttestation({
      ...codexUnsupported,
      safeErrorCode: "CLAUDE_VERSION_DRIFT",
    }),
    false,
  );
  assert.equal(
    isCompatibilityAttestation({
      ...codexUnsupported,
      safeErrorCode: "CODEX_VERSION_DRIFT",
    }),
    true,
  );

  const passingUncertified = {
    ...evaluateCompatibilityAttestation({
      surface: "claude" as const,
      version: "2.1.228",
      checkedAt: "2026-08-09T12:00:00.000Z",
      certifiedVersions: ["2.1.227"],
      probes: passing("claude"),
    }),
    tier: "certified" as const,
  };
  assert.equal(isCompatibilityAttestation(passingUncertified), false);
  assert.equal(isPersistedCompatibilityAttestation(passingUncertified), true);
  assert.equal(
    isCompatibilityAttestation({
      ...passingUncertified,
      version: UNKNOWN_COMPATIBILITY_VERSION,
    }),
    false,
  );
  assert.equal(
    isCompatibilityAttestation({
      ...passingUncertified,
      version: UNKNOWN_COMPATIBILITY_VERSION,
      tier: "incompatible",
      safeErrorCode: "CLAUDE_VERSION_DRIFT",
    }),
    false,
  );
  assert.equal(
    isCompatibilityAttestation({
      ...passingUncertified,
      version: "2.1.224",
    }),
    false,
  );
  assert.equal(
    isCompatibilityAttestation({
      ...passingUncertified,
      version: "2.1.226",
      tier: "incompatible",
      safeErrorCode: "CLAUDE_VERSION_DRIFT",
    }),
    true,
  );
  assert.equal(
    isCompatibilityAttestation({
      ...passingUncertified,
      version: "2.1.226",
      tier: "incompatible",
      safeErrorCode: "CODEX_VERSION_DRIFT",
    }),
    false,
  );

  assert.throws(
    () =>
      evaluateCompatibilityAttestation({
        surface: "claude",
        version: "development-build",
        checkedAt: "2026-08-09T12:00:00.000Z",
        certifiedVersions: ["2.1.227"],
        probes: passing("claude"),
      }),
    { message: /semantic versions or explicit unknown evidence/ },
  );
});
