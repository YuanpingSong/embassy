import assert from "node:assert/strict";
import { test } from "node:test";

import {
  compatibilityCacheKey,
  compatibilityCoversWrites,
  compatibilityProbeNames,
  compatibilitySurfaceDefinitions,
  isCompatibilityAttestation,
  isCompatibilityVersion,
  isPersistedCompatibilityAttestation,
  sharesCompatibilityMajor,
  UNKNOWN_COMPATIBILITY_VERSION,
  type CompatibilityAttestation,
  type CompatibilityProbeResult,
  type CompatibilitySurface,
} from "../src/gateway/compatibility.js";
import { gatewayPublicSnapshotLimits } from "../src/gateway/types.js";

const checkedAt = "2026-08-16T12:00:00.000Z";

function passing(surface: CompatibilitySurface): CompatibilityProbeResult[] {
  return compatibilityProbeNames[surface].map((name) => ({
    name,
    outcome: "pass",
  }));
}

function attestation(
  overrides: Partial<CompatibilityAttestation> = {},
): CompatibilityAttestation {
  return {
    schemaVersion: 1,
    surface: "claude",
    version: "2.1.227",
    tier: "certified",
    checkedAt,
    probes: passing("claude"),
    ...overrides,
  };
}

test("the legacy compatibility schema inventory remains bounded until emb-68", () => {
  assert.deepEqual(compatibilitySurfaceDefinitions, [
    { surface: "claude", required: true },
    { surface: "codex", required: true },
    { surface: "deepseek", required: false },
  ]);
  assert.equal(
    gatewayPublicSnapshotLimits.compatibilityChecks,
    compatibilitySurfaceDefinitions.length,
  );
});

test("bounded semantic-version syntax remains available to runtime metadata", () => {
  for (const version of [
    "2.2.0-rc",
    "2.2.0-rc.1",
    "0.147.1-dev-20260816",
  ]) {
    assert.equal(isCompatibilityVersion(version), true);
  }
  for (const version of [
    "2.2.0-",
    "2.2.0-rc..1",
    "2.2.0-01",
    "2.2.0+build",
    `2.2.0-${"a".repeat(129)}`,
  ]) {
    assert.equal(isCompatibilityVersion(version), false);
  }
  assert.equal(sharesCompatibilityMajor("2.1.0", "2.99.0-rc.1"), true);
  assert.equal(sharesCompatibilityMajor("0.147.0", "0.147.9-rc.1"), true);
  assert.equal(sharesCompatibilityMajor("0.147.0", "0.148.0"), false);
  assert.equal(sharesCompatibilityMajor("0.147.0", "invalid"), false);
});

test("persisted compatibility evidence remains strict and release-invariant", () => {
  const certified = attestation();
  assert.equal(isPersistedCompatibilityAttestation(certified), true);
  assert.equal(isCompatibilityAttestation(certified), true);

  const historicalProbeSchema = attestation({
    version: "2.1.226",
    probes: passing("claude").map((probe, index) =>
      index === 0 ? { ...probe, name: "launcher_v0" } : probe,
    ) as CompatibilityProbeResult[],
  });
  assert.equal(isCompatibilityAttestation(historicalProbeSchema), false);
  assert.equal(
    isPersistedCompatibilityAttestation(historicalProbeSchema),
    true,
  );

  assert.equal(
    isPersistedCompatibilityAttestation({
      ...historicalProbeSchema,
      probes: [
        ...historicalProbeSchema.probes,
        historicalProbeSchema.probes[0],
      ],
    }),
    false,
  );
  assert.equal(
    isPersistedCompatibilityAttestation({
      ...certified,
      version: UNKNOWN_COMPATIBILITY_VERSION,
    }),
    false,
  );
  assert.equal(
    isPersistedCompatibilityAttestation({
      ...certified,
      checkedAt: "not-a-timestamp",
    }),
    false,
  );
});

test("legacy failure rows require an exact safe code", () => {
  const probes = passing("codex");
  probes[2] = {
    name: "initialize",
    outcome: "fail",
    safeErrorCode: "CODEX_INITIALIZE_SCHEMA_INVALID",
  };
  const failed = attestation({
    surface: "codex",
    version: "0.148.0",
    tier: "incompatible",
    probes,
    safeErrorCode: "CODEX_INITIALIZE_SCHEMA_INVALID",
  });
  assert.equal(isPersistedCompatibilityAttestation(failed), true);
  assert.equal(isCompatibilityAttestation(failed), true);
  assert.equal(
    isPersistedCompatibilityAttestation({
      ...failed,
      safeErrorCode: "CODEX_VERSION_DRIFT",
    }),
    false,
  );
  assert.equal(
    isPersistedCompatibilityAttestation({
      ...failed,
      probes: [...failed.probes].reverse(),
    }),
    true,
  );
  assert.equal(
    isCompatibilityAttestation({
      ...failed,
      probes: [...failed.probes].reverse(),
    }),
    false,
  );
});

test("legacy writesCovered projection is inert and schema-derived", () => {
  const writeAttested = attestation({
    surface: "codex",
    version: "0.147.1",
    tier: "schema_attested",
    probes: [
      ...passing("codex"),
      { name: "write_attestation", outcome: "pass" },
    ],
  });
  assert.equal(isPersistedCompatibilityAttestation(writeAttested), true);
  assert.equal(isCompatibilityAttestation(writeAttested), true);
  assert.equal(compatibilityCoversWrites(writeAttested), true);
  assert.equal(
    compatibilityCoversWrites({ ...writeAttested, tier: "incompatible" }),
    false,
  );
  assert.equal(
    compatibilityCoversWrites({ ...writeAttested, version: "0.147.1-rc.1" }),
    false,
  );
});

test("legacy persisted rows keep their stable bounded cache key", () => {
  assert.equal(
    compatibilityCacheKey(attestation({ version: "2.1.226" })),
    "claude\0" + "2.1.226",
  );
});
