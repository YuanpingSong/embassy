export const compatibilitySurfaces = Object.freeze([
  "claude",
  "codex",
  "deepseek",
] as const);

export type CompatibilitySurface = (typeof compatibilitySurfaces)[number];

/** Bounded evidence used when a version banner is present but not parseable. */
export const UNKNOWN_COMPATIBILITY_VERSION = "unknown" as const;

/** TODO(emb-69): remove with the DeepSeek online version observer. */
export type CompatibilityProbeResult = Readonly<{
  name: "installation" | "harness_home" | "version";
  outcome: "pass" | "fail";
  safeErrorCode?: string;
}>;

/** TODO(emb-69): remove with the DeepSeek online version observer. */
export type CompatibilitySurfaceObservation = Readonly<{
  surface: CompatibilitySurface;
  version: string;
}>;

/** TODO(emb-69): remove with the DeepSeek online version observer. */
export interface CompatibilitySurfaceObserver {
  compatibilitySurface(): CompatibilitySurfaceObservation;
  runCompatibilityProbes(): Promise<readonly CompatibilityProbeResult[]>;
}

const VERSION_PATTERN =
  /^(?=.{1,128}$)([0-9]{1,4})\.([0-9]{1,4})\.([0-9]{1,4})(?:-([0-9A-Za-z-]{1,64}(?:\.[0-9A-Za-z-]{1,64}){0,7}))?$/;

export function isCompatibilityVersion(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = VERSION_PATTERN.exec(value);
  if (match === null) return false;
  const prerelease = match[4];
  return prerelease === undefined || !prerelease.split(".").some(
    (identifier) =>
      /^[0-9]+$/.test(identifier) &&
      identifier.length > 1 &&
      identifier.startsWith("0"),
  );
}

export function isCompatibilityVersionEvidence(
  value: unknown,
): value is string {
  return (
    value === UNKNOWN_COMPATIBILITY_VERSION || isCompatibilityVersion(value)
  );
}
