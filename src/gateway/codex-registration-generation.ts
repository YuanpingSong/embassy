import { randomBytes } from "node:crypto";

const CODEX_REGISTRATION_GENERATION_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/u;

/** Closed grammar for opaque Codex listener and succession generations. */
export function isCodexRegistrationGeneration(
  value: unknown,
): value is string {
  return (
    typeof value === "string" &&
    CODEX_REGISTRATION_GENERATION_PATTERN.test(value)
  );
}

export function assertCodexRegistrationGeneration(
  value: unknown,
  label = "Codex registration generation",
): asserts value is string {
  if (!isCodexRegistrationGeneration(value)) {
    throw new TypeError(
      `${label} must match the bounded opaque generation grammar.`,
    );
  }
}

/** A fresh 128-bit token that is safe in the closed generation grammar. */
export function createCodexRegistrationGeneration(): string {
  const generation = `g_${randomBytes(16).toString("base64url")}`;
  assertCodexRegistrationGeneration(generation);
  return generation;
}
