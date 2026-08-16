import { BridgeError } from "../errors.js";

export const compatibilitySurfaceDefinitions = [
  { surface: "claude", required: true },
  { surface: "codex", required: true },
  { surface: "deepseek", required: false },
] as const;
export type CompatibilitySurface =
  (typeof compatibilitySurfaceDefinitions)[number]["surface"];
export type CompatibilitySurfaceDefinition = Readonly<{
  surface: CompatibilitySurface;
  required: boolean;
}>;
export const compatibilitySurfaces = Object.freeze(
  compatibilitySurfaceDefinitions.map(({ surface }) => surface),
);

/** Exact upstream builds exercised by this release's deterministic suite. */
export const certifiedCompatibilityVersions = Object.freeze({
  claude: Object.freeze(["2.1.227"]),
  codex: Object.freeze(["0.147.0"]),
  deepseek: Object.freeze([]),
} satisfies Readonly<Record<CompatibilitySurface, readonly string[]>>);

/** Bounded evidence used when a version banner is present but not parseable. */
export const UNKNOWN_COMPATIBILITY_VERSION = "unknown" as const;

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
  deepseek: ["installation", "harness_home", "version"],
} as const;

const compatibilityOptionalProbeNames = {
  claude: [],
  codex: ["write_attestation"],
  deepseek: [],
} as const satisfies Readonly<Record<CompatibilitySurface, readonly string[]>>;

export type CompatibilityProbeName =
  | (typeof compatibilityProbeNames)[CompatibilitySurface][number]
  | (typeof compatibilityOptionalProbeNames)[CompatibilitySurface][number];

export type CompatibilityProbeResult = Readonly<{
  name: CompatibilityProbeName;
  outcome: "pass" | "fail";
  safeErrorCode?: string;
}>;

export type CompatibilityAttestation = Readonly<{
  schemaVersion: 1;
  surface: CompatibilitySurface;
  version: string;
  tier: CompatibilityTier;
  checkedAt: string;
  probes: readonly CompatibilityProbeResult[];
  safeErrorCode?: string;
}>;

export type CompatibilitySurfaceObservation = Readonly<{
  surface: CompatibilitySurface;
  version: string;
}>;

export interface CompatibilitySurfaceObserver {
  compatibilitySurface(): CompatibilitySurfaceObservation;
  runCompatibilityProbes(): Promise<readonly CompatibilityProbeResult[]>;
  acceptCompatibilityAttestation?(attestation: CompatibilityAttestation): void;
}

const VERSION_PATTERN = /^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}$/;
const SAFE_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
const PERSISTED_PROBE_NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const PERSISTED_PROBE_CAPACITY = 32;

function legacyVersionDriftCode(surface: CompatibilitySurface): string {
  switch (surface) {
    case "claude":
      return "CLAUDE_VERSION_DRIFT";
    case "codex":
      return "CODEX_VERSION_DRIFT";
    case "deepseek":
      return "DEEPSEEK_HARNESS_VERSION_DRIFT";
  }
  const exhaustive: never = surface;
  return exhaustive;
}

function unsupportedVersionCode(
  surface: CompatibilitySurface,
  version: string,
  certifiedVersions: readonly string[] =
    certifiedCompatibilityVersions[surface],
): string | undefined {
  if (version === UNKNOWN_COMPATIBILITY_VERSION) {
    switch (surface) {
      case "claude":
        return "CLAUDE_VERSION_UNPARSEABLE";
      case "codex":
        return "CODEX_APP_SERVER_VERSION_UNPARSEABLE";
      case "deepseek":
        return "DEEPSEEK_HARNESS_VERSION_UNPARSEABLE";
    }
    const exhaustive: never = surface;
    return exhaustive;
  }
  if (
    certifiedVersions.some((certifiedVersion) =>
      sharesCompatibilityMajor(certifiedVersion, version),
    )
  ) {
    return undefined;
  }
  switch (surface) {
    case "claude":
      return "CLAUDE_PEER_VERSION_UNSUPPORTED";
    case "codex":
      return "CODEX_APP_SERVER_VERSION_UNSUPPORTED";
    case "deepseek":
      return "DEEPSEEK_HARNESS_VERSION_UNSUPPORTED";
  }
  const exhaustive: never = surface;
  return exhaustive;
}

function versionMajor(version: string): number {
  return Number(version.slice(0, version.indexOf(".")));
}

export function isCompatibilityVersion(value: unknown): value is string {
  return typeof value === "string" && VERSION_PATTERN.test(value);
}

export function isCompatibilityVersionEvidence(value: unknown): value is string {
  return value === UNKNOWN_COMPATIBILITY_VERSION || isCompatibilityVersion(value);
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

function hasCurrentProbeSequence(
  surface: CompatibilitySurface,
  probes: readonly CompatibilityProbeResult[],
): boolean {
  const required = compatibilityProbeNames[surface] as readonly string[];
  const optional = compatibilityOptionalProbeNames[surface] as readonly string[];
  const suffix = probes.slice(required.length);
  return !(
    probes.length < required.length ||
    probes.length > required.length + optional.length ||
    required.some((name, index) => probes[index]?.name !== name)
  ) && suffix.every((probe, index) =>
    optional.indexOf(probe.name) >
      optional.indexOf(suffix[index - 1]?.name ?? "") &&
    probe.outcome === "pass" && probe.safeErrorCode === undefined
  );
}

function normalizeProbes(
  surface: CompatibilitySurface,
  probes: readonly CompatibilityProbeResult[],
): readonly CompatibilityProbeResult[] {
  if (
    !hasCurrentProbeSequence(surface, probes) ||
    probes.some(
      (probe) =>
        (probe.outcome !== "pass" && probe.outcome !== "fail") ||
        (probe.safeErrorCode !== undefined &&
          !SAFE_CODE_PATTERN.test(probe.safeErrorCode)) ||
        (probe.outcome === "pass" && probe.safeErrorCode !== undefined) ||
        (probe.outcome === "fail" && probe.safeErrorCode === undefined),
    )
  ) {
    throw new BridgeError(
      "COMPAT_PROBE_SET_INVALID",
      "Compatibility probes must contain the exact ordered surface probe set plus known passing optional probes.",
    );
  }
  return probes.map((probe) => Object.freeze({ ...probe }));
}

function persistedProbeSet(
  value: readonly unknown[],
): readonly CompatibilityProbeResult[] | undefined {
  if (value.length === 0 || value.length > PERSISTED_PROBE_CAPACITY) {
    return undefined;
  }
  const names = new Set<string>();
  for (const candidate of value) {
    if (
      typeof candidate !== "object" ||
      candidate === null ||
      Array.isArray(candidate)
    ) {
      return undefined;
    }
    const probe = candidate as Record<string, unknown>;
    const keys = Object.keys(probe);
    if (
      keys.length !== (probe.safeErrorCode === undefined ? 2 : 3) ||
      keys.some(
        (key) =>
          key !== "name" && key !== "outcome" && key !== "safeErrorCode",
      ) ||
      typeof probe.name !== "string" ||
      !PERSISTED_PROBE_NAME_PATTERN.test(probe.name) ||
      names.has(probe.name) ||
      (probe.outcome !== "pass" && probe.outcome !== "fail") ||
      (probe.safeErrorCode !== undefined &&
        (typeof probe.safeErrorCode !== "string" ||
          !SAFE_CODE_PATTERN.test(probe.safeErrorCode))) ||
      (probe.outcome === "pass") !== (probe.safeErrorCode === undefined)
    ) {
      return undefined;
    }
    names.add(probe.name);
  }
  return value as readonly CompatibilityProbeResult[];
}

export function evaluateCompatibilityAttestation(input: Readonly<{
  surface: CompatibilitySurface;
  version: string;
  checkedAt: string;
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
  if (!isCompatibilityVersionEvidence(input.version)) {
    throw new BridgeError(
      "COMPAT_VERSION_INVALID",
      "Compatibility versions must be bounded semantic versions or explicit unknown evidence.",
    );
  }
  const certified = new Set(input.certifiedVersions);
  if (
    certified.size !== input.certifiedVersions.length ||
    (input.certifiedVersions.length === 0 &&
      compatibilitySurfaceDefinitions.find(
        ({ surface }) => surface === input.surface,
      )?.required !== false) ||
    input.certifiedVersions.some((version) => !VERSION_PATTERN.test(version))
  ) {
    throw new BridgeError(
      "COMPAT_CERTIFIED_SET_INVALID",
      "The certified version inventory must be nonempty, unique, and bounded.",
    );
  }
  const normalizedProbes = normalizeProbes(input.surface, input.probes);
  const failed = normalizedProbes.find((probe) => probe.outcome === "fail");
  let tier: CompatibilityTier;
  let safeErrorCode: string | undefined;
  if (failed !== undefined) {
    tier = "incompatible";
    safeErrorCode = failed.safeErrorCode;
  } else if (certified.has(input.version)) {
    tier = "certified";
  } else {
    safeErrorCode = unsupportedVersionCode(
      input.surface,
      input.version,
      input.certifiedVersions,
    );
    tier = safeErrorCode === undefined ? "schema_attested" : "incompatible";
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

/**
 * Validate the immutable evidence carried by a persisted attestation without
 * consulting this build's release inventory. A release may later certify or
 * stop certifying the observed version; neither change can corrupt evidence
 * written by an earlier release.
 */
export function isPersistedCompatibilityAttestation(
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
    ...(candidate.safeErrorCode === undefined ? [] : ["safeErrorCode"]),
  ]);
  if (keys.length !== expected.size || keys.some((key) => !expected.has(key))) {
    return false;
  }
  if (
    candidate.schemaVersion !== 1 ||
    !compatibilitySurfaces.includes(candidate.surface as CompatibilitySurface) ||
    !isCompatibilityVersionEvidence(candidate.version) ||
    !compatibilityTiers.includes(candidate.tier as CompatibilityTier) ||
    typeof candidate.checkedAt !== "string" ||
    !Number.isFinite(Date.parse(candidate.checkedAt)) ||
    new Date(Date.parse(candidate.checkedAt)).toISOString() !==
      candidate.checkedAt ||
    !Array.isArray(candidate.probes) ||
    (candidate.safeErrorCode !== undefined &&
      (typeof candidate.safeErrorCode !== "string" ||
        !SAFE_CODE_PATTERN.test(candidate.safeErrorCode)))
  ) {
    return false;
  }
  try {
    const persistedProbes = persistedProbeSet(candidate.probes);
    if (persistedProbes === undefined) return false;
    const failed = persistedProbes.find((probe) => probe.outcome === "fail");
    if (candidate.tier === "certified") {
      return (
        failed === undefined &&
        candidate.version !== UNKNOWN_COMPATIBILITY_VERSION &&
        candidate.safeErrorCode === undefined
      );
    }
    if (candidate.tier === "incompatible") {
      if (failed !== undefined) {
        return candidate.safeErrorCode === failed.safeErrorCode;
      }
      return candidate.safeErrorCode !== undefined;
    }
    return (
      failed === undefined &&
      candidate.safeErrorCode === undefined &&
      candidate.version !== UNKNOWN_COMPATIBILITY_VERSION
    );
  } catch {
    return false;
  }
}

/** Validate a fresh attestation against this build's admission policy. */
export function isCompatibilityAttestation(
  value: unknown,
): value is CompatibilityAttestation {
  if (!isPersistedCompatibilityAttestation(value)) return false;
  if (!hasCurrentProbeSequence(value.surface, value.probes)) {
    return false;
  }
  if (value.tier === "certified") {
    return (certifiedCompatibilityVersions[value.surface] as readonly string[])
      .includes(value.version);
  }
  if (value.tier === "incompatible") {
    if (value.probes.some((probe) => probe.outcome === "fail")) return true;
    return (
      value.safeErrorCode ===
        unsupportedVersionCode(value.surface, value.version) ||
      (value.version !== UNKNOWN_COMPATIBILITY_VERSION &&
        value.safeErrorCode === legacyVersionDriftCode(value.surface))
    );
  }
  return (
    !(certifiedCompatibilityVersions[value.surface] as readonly string[])
      .includes(value.version) &&
    unsupportedVersionCode(value.surface, value.version) === undefined
  );
}

export function compatibilityCoversWrites(
  attestation: Pick<CompatibilityAttestation, "surface" | "tier" | "probes">,
): boolean {
  return (
    attestation.surface === "codex" &&
    attestation.tier === "schema_attested" &&
    attestation.probes.some((probe) =>
      probe.name === "write_attestation" && probe.outcome === "pass"
    )
  );
}

export function compatibilityCacheKey(
  attestation: Pick<CompatibilityAttestation, "surface" | "version">,
): string {
  return `${attestation.surface}\0${attestation.version}`;
}
