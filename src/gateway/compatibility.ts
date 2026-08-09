import { BridgeError } from "../errors.js";

export const compatibilityPolicies = ["observed", "strict"] as const;
export type CompatibilityPolicy = (typeof compatibilityPolicies)[number];

export const compatibilitySurfaces = ["claude", "codex"] as const;
export type CompatibilitySurface = (typeof compatibilitySurfaces)[number];

/** Exact upstream builds exercised by this release's deterministic suite. */
export const certifiedCompatibilityVersions = Object.freeze({
  claude: Object.freeze(["2.1.224", "2.1.225", "2.1.226"]),
  codex: Object.freeze(["0.147.0"]),
} satisfies Readonly<Record<CompatibilitySurface, readonly string[]>>);

export const compatibilityTiers = [
  "certified",
  "schema_attested",
  "incompatible",
] as const;
export type CompatibilityTier = (typeof compatibilityTiers)[number];

export const compatibilityProbeNames = {
  claude: [
    "launcher",
    "version",
    "registry_schema",
    "messaging_socket",
    "protocol_constants",
  ],
  codex: [
    "installation",
    "control_socket",
    "initialize",
    "thread_list",
  ],
} as const;

export type CompatibilityProbeName =
  (typeof compatibilityProbeNames)[CompatibilitySurface][number];

export type CompatibilityProbeResult = Readonly<{
  name: CompatibilityProbeName;
  outcome: "pass" | "fail";
  safeErrorCode?: string;
}>;

export const compatibilityCertificationDepths = [
  "wire",
  "thread_ops",
  "turn",
] as const;
export type CompatibilityCertificationDepth =
  (typeof compatibilityCertificationDepths)[number];

export type CompatibilityCertification = Readonly<{
  depth: CompatibilityCertificationDepth;
  outcome: "pass" | "fail";
  certifiedAt: string;
  safeErrorCode?: string;
}>;

export type CompatibilityAttestation = Readonly<{
  schemaVersion: 1;
  surface: CompatibilitySurface;
  version: string;
  tier: CompatibilityTier;
  checkedAt: string;
  probes: readonly CompatibilityProbeResult[];
  certification?: CompatibilityCertification;
  safeErrorCode?: string;
}>;

export type CompatibilitySurfaceObservation = Readonly<{
  surface: CompatibilitySurface;
  version: string;
}>;

export type CompatibilityCheckReport = Readonly<{
  policy: CompatibilityPolicy;
  compatible: boolean;
  surfaces: readonly CompatibilityAttestation[];
}>;

export type CompatibilityCertificationReport = Readonly<{
  policy: CompatibilityPolicy;
  certified: boolean;
  withTurn: boolean;
  surfaces: readonly CompatibilityAttestation[];
}>;

const VERSION_PATTERN = /^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}$/;
const SAFE_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;

function versionDriftCode(surface: CompatibilitySurface): string {
  return surface === "claude" ? "CLAUDE_VERSION_DRIFT" : "CODEX_VERSION_DRIFT";
}

function requiredProbeNames(
  surface: CompatibilitySurface,
): readonly CompatibilityProbeName[] {
  return compatibilityProbeNames[surface];
}

function versionMajor(version: string): number {
  if (!VERSION_PATTERN.test(version)) {
    throw new BridgeError(
      "COMPAT_VERSION_INVALID",
      "Compatibility versions must use bounded numeric semantic version syntax.",
    );
  }
  return Number(version.slice(0, version.indexOf(".")));
}

export function isCompatibilityVersion(value: unknown): value is string {
  return typeof value === "string" && VERSION_PATTERN.test(value);
}

export function sharesCompatibilityMajor(
  left: string,
  right: string,
): boolean {
  return (
    isCompatibilityVersion(left) &&
    isCompatibilityVersion(right) &&
    versionMajor(left) === versionMajor(right)
  );
}

function normalizeProbes(
  surface: CompatibilitySurface,
  probes: readonly CompatibilityProbeResult[],
): readonly CompatibilityProbeResult[] {
  const required = requiredProbeNames(surface);
  if (
    probes.length !== required.length ||
    probes.some(
      (probe, index) =>
        probe.name !== required[index] ||
        (probe.outcome !== "pass" && probe.outcome !== "fail") ||
        (probe.safeErrorCode !== undefined &&
          !SAFE_CODE_PATTERN.test(probe.safeErrorCode)) ||
        (probe.outcome === "pass" && probe.safeErrorCode !== undefined) ||
        (probe.outcome === "fail" && probe.safeErrorCode === undefined),
    )
  ) {
    throw new BridgeError(
      "COMPAT_PROBE_SET_INVALID",
      "Compatibility probes must contain the exact ordered surface probe set.",
    );
  }
  return probes.map((probe) => Object.freeze({ ...probe }));
}

export function evaluateCompatibilityAttestation(input: Readonly<{
  surface: CompatibilitySurface;
  version: string;
  checkedAt: string;
  policy: CompatibilityPolicy;
  certifiedVersions: readonly string[];
  probes: readonly CompatibilityProbeResult[];
}>): CompatibilityAttestation {
  const observedAt = Date.parse(input.checkedAt);
  if (
    !Number.isFinite(observedAt) ||
    new Date(observedAt).toISOString() !== input.checkedAt
  ) {
    throw new BridgeError(
      "COMPAT_TIMESTAMP_INVALID",
      "Compatibility evidence requires a valid timestamp.",
    );
  }
  const versionMajorNumber = versionMajor(input.version);
  const certified = new Set(input.certifiedVersions);
  if (
    certified.size !== input.certifiedVersions.length ||
    input.certifiedVersions.length === 0 ||
    input.certifiedVersions.some((version) => !VERSION_PATTERN.test(version))
  ) {
    throw new BridgeError(
      "COMPAT_CERTIFIED_SET_INVALID",
      "The certified version inventory must be nonempty, unique, and bounded.",
    );
  }
  const normalizedProbes = normalizeProbes(input.surface, input.probes);
  const failed = normalizedProbes.find((probe) => probe.outcome === "fail");
  const certifiedVersion = certified.has(input.version);
  const certifiedMajors = new Set(
    input.certifiedVersions.map((version) => versionMajor(version)),
  );
  const majorCompatible = certifiedMajors.has(versionMajorNumber);

  let tier: CompatibilityTier;
  let safeErrorCode: string | undefined;
  if (failed !== undefined) {
    tier = "incompatible";
    safeErrorCode = failed.safeErrorCode;
  } else if (certifiedVersion) {
    tier = "certified";
  } else if (input.policy === "observed" && majorCompatible) {
    tier = "schema_attested";
  } else {
    tier = "incompatible";
    safeErrorCode = versionDriftCode(input.surface);
  }

  return Object.freeze({
    schemaVersion: 1,
    surface: input.surface,
    version: input.version,
    tier,
    checkedAt: new Date(observedAt).toISOString(),
    probes: normalizedProbes,
    ...(safeErrorCode === undefined ? {} : { safeErrorCode }),
  });
}

export function isCompatibilityAttestation(
  value: unknown,
): value is CompatibilityAttestation {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  const keys = Object.keys(candidate);
  const expected = new Set([
    "schemaVersion",
    "surface",
    "version",
    "tier",
    "checkedAt",
    "probes",
    ...(candidate.certification === undefined ? [] : ["certification"]),
    ...(candidate.safeErrorCode === undefined ? [] : ["safeErrorCode"]),
  ]);
  if (keys.length !== expected.size || keys.some((key) => !expected.has(key))) {
    return false;
  }
  if (
    candidate.schemaVersion !== 1 ||
    !compatibilitySurfaces.includes(candidate.surface as CompatibilitySurface) ||
    typeof candidate.version !== "string" ||
    !VERSION_PATTERN.test(candidate.version) ||
    !compatibilityTiers.includes(candidate.tier as CompatibilityTier) ||
    typeof candidate.checkedAt !== "string" ||
    !Number.isFinite(Date.parse(candidate.checkedAt)) ||
    new Date(Date.parse(candidate.checkedAt)).toISOString() !==
      candidate.checkedAt ||
    !Array.isArray(candidate.probes) ||
    (candidate.certification !== undefined &&
      !isCompatibilityCertification(candidate.certification)) ||
    (candidate.safeErrorCode !== undefined &&
      (typeof candidate.safeErrorCode !== "string" ||
        !SAFE_CODE_PATTERN.test(candidate.safeErrorCode)))
  ) {
    return false;
  }
  try {
    const normalized = normalizeProbes(
      candidate.surface as CompatibilitySurface,
      candidate.probes as CompatibilityProbeResult[],
    );
    const failed = normalized.find((probe) => probe.outcome === "fail");
    if (candidate.tier === "incompatible") {
      return (
        candidate.safeErrorCode ===
        (failed?.safeErrorCode ??
          versionDriftCode(candidate.surface as CompatibilitySurface))
      );
    }
    return failed === undefined && candidate.safeErrorCode === undefined;
  } catch {
    return false;
  }
}

export function isCompatibilityCertification(
  value: unknown,
): value is CompatibilityCertification {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  const expected = new Set([
    "depth",
    "outcome",
    "certifiedAt",
    ...(candidate.safeErrorCode === undefined ? [] : ["safeErrorCode"]),
  ]);
  const parsedAt =
    typeof candidate.certifiedAt === "string"
      ? Date.parse(candidate.certifiedAt)
      : Number.NaN;
  return (
    Object.keys(candidate).length === expected.size &&
    Object.keys(candidate).every((key) => expected.has(key)) &&
    compatibilityCertificationDepths.includes(
      candidate.depth as CompatibilityCertificationDepth,
    ) &&
    (candidate.outcome === "pass" || candidate.outcome === "fail") &&
    Number.isFinite(parsedAt) &&
    new Date(parsedAt).toISOString() === candidate.certifiedAt &&
    (candidate.safeErrorCode === undefined ||
      (typeof candidate.safeErrorCode === "string" &&
        SAFE_CODE_PATTERN.test(candidate.safeErrorCode))) &&
    (candidate.outcome === "pass") ===
      (candidate.safeErrorCode === undefined)
  );
}

export function attachCompatibilityCertification(
  attestation: CompatibilityAttestation,
  certification: CompatibilityCertification,
): CompatibilityAttestation {
  if (
    !isCompatibilityAttestation(attestation) ||
    !isCompatibilityCertification(certification)
  ) {
    throw new BridgeError(
      "COMPAT_CERTIFICATION_INVALID",
      "Compatibility certification must attach to one compatible attested surface.",
    );
  }
  return Object.freeze({
    ...attestation,
    certification: Object.freeze({ ...certification }),
  });
}

export function compatibilityCacheKey(
  attestation: Pick<CompatibilityAttestation, "surface" | "version">,
): string {
  return `${attestation.surface}\0${attestation.version}`;
}

export function isCompatibilityCheckReport(
  value: unknown,
): value is CompatibilityCheckReport {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  if (
    Object.keys(candidate).length !== 3 ||
    !Object.hasOwn(candidate, "policy") ||
    !Object.hasOwn(candidate, "compatible") ||
    !Object.hasOwn(candidate, "surfaces") ||
    !compatibilityPolicies.includes(candidate.policy as CompatibilityPolicy) ||
    typeof candidate.compatible !== "boolean" ||
    !Array.isArray(candidate.surfaces) ||
    candidate.surfaces.length !== compatibilitySurfaces.length ||
    !candidate.surfaces.every(isCompatibilityAttestation)
  ) {
    return false;
  }
  const surfaces = candidate.surfaces as CompatibilityAttestation[];
  return (
    surfaces.every(
      (attestation, index) =>
        attestation.surface === compatibilitySurfaces[index],
    ) &&
    candidate.compatible ===
      surfaces.every((attestation) => attestation.tier !== "incompatible")
  );
}

export function isCompatibilityCertificationReport(
  value: unknown,
): value is CompatibilityCertificationReport {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  if (
    Object.keys(candidate).length !== 4 ||
    !Object.hasOwn(candidate, "policy") ||
    !Object.hasOwn(candidate, "certified") ||
    !Object.hasOwn(candidate, "withTurn") ||
    !Object.hasOwn(candidate, "surfaces") ||
    !compatibilityPolicies.includes(candidate.policy as CompatibilityPolicy) ||
    typeof candidate.certified !== "boolean" ||
    typeof candidate.withTurn !== "boolean" ||
    !Array.isArray(candidate.surfaces) ||
    candidate.surfaces.length !== compatibilitySurfaces.length ||
    !candidate.surfaces.every(isCompatibilityAttestation)
  ) {
    return false;
  }
  const surfaces = candidate.surfaces as CompatibilityAttestation[];
  return (
    surfaces.every(
      (attestation, index) =>
        attestation.surface === compatibilitySurfaces[index] &&
        attestation.certification !== undefined &&
        (attestation.surface === "claude"
          ? attestation.certification.depth === "wire"
          : candidate.withTurn
            ? attestation.certification.depth === "turn"
            : attestation.certification.depth === "thread_ops"),
    ) &&
    candidate.certified ===
      surfaces.every(
        (attestation) => attestation.certification?.outcome === "pass",
      )
  );
}
