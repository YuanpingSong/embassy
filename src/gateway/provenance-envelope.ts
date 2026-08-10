import { createHash } from "node:crypto";

import { BridgeError } from "../errors.js";

export const PROVENANCE_RAW_BODY_MAX_BYTES = 16 * 1024;
export const PROVENANCE_ENVELOPE_MAX_BYTES = 64 * 1024;

const ALIAS_PATTERN =
  /^[a-z][a-z0-9_-]{0,31}@[a-z0-9](?:[a-z0-9.-]{0,61}[a-z0-9])?$/;
const CONVERSATION_ID_PATTERN = /^conv_[A-Za-z0-9_-]{16,64}$/;
const RESERVED_TAG_PATTERN =
  /<(?=\/?(?:cross-session-message|embassy-reply-hint)(?:[>\s/]|$))/giu;
const CLAUDE_FROM_NAME_MAX_CODEPOINTS = 64;
const LONG_ALIAS_PREFIX_CODEPOINTS = 47;
const LONG_ALIAS_HASH_HEX_LENGTH = 16;

export type ProvenanceEnvelopeDirection = "codex" | "claude";

export type ComposeProvenanceEnvelopeInput = Readonly<{
  direction: ProvenanceEnvelopeDirection;
  sourceAlias: string;
  targetAlias: string;
  conversationId: string;
  body: string;
}>;

function invalidEnvelope(): never {
  throw new BridgeError(
    "PROVENANCE_ENVELOPE_INVALID",
    "The provenance envelope metadata is invalid.",
  );
}

function envelopeTooLarge(): never {
  throw new BridgeError(
    "PROVENANCE_ENVELOPE_TOO_LARGE",
    "The provenance envelope exceeds its byte limit.",
  );
}

function validateInput(input: ComposeProvenanceEnvelopeInput): void {
  if (
    typeof input !== "object" ||
    input === null ||
    (input.direction !== "codex" && input.direction !== "claude") ||
    typeof input.sourceAlias !== "string" ||
    !ALIAS_PATTERN.test(input.sourceAlias) ||
    typeof input.targetAlias !== "string" ||
    !ALIAS_PATTERN.test(input.targetAlias) ||
    typeof input.conversationId !== "string" ||
    !CONVERSATION_ID_PATTERN.test(input.conversationId) ||
    typeof input.body !== "string"
  ) {
    invalidEnvelope();
  }

  if (Buffer.byteLength(input.body, "utf8") > PROVENANCE_RAW_BODY_MAX_BYTES) {
    envelopeTooLarge();
  }
}

function claudeDisplayAlias(alias: string): {
  displayAlias: string;
  shortened: boolean;
} {
  const codepoints = [...alias];
  if (codepoints.length <= CLAUDE_FROM_NAME_MAX_CODEPOINTS) {
    return { displayAlias: alias, shortened: false };
  }

  const digest = createHash("sha256")
    .update(alias, "utf8")
    .digest("hex")
    .slice(0, LONG_ALIAS_HASH_HEX_LENGTH);
  return {
    displayAlias: `${codepoints.slice(0, LONG_ALIAS_PREFIX_CODEPOINTS).join("")}~${digest}`,
    shortened: true,
  };
}

function neutralizeReservedTags(body: string): string {
  return body.replace(RESERVED_TAG_PATTERN, "<\\");
}

/**
 * Adds broker-owned, Claude-compatible textual framing at the provider write
 * boundary. The result is not general XML and does not provide a cryptographic
 * signature; the wrapper is a structural provenance marker for the recipient.
 */
export function composeProvenanceEnvelope(
  input: ComposeProvenanceEnvelopeInput,
): string {
  validateInput(input);

  const display = claudeDisplayAlias(input.sourceAlias);
  const fromName =
    input.direction === "codex" ? input.sourceAlias : display.displayAlias;
  const conversationAttribute =
    input.direction === "codex"
      ? ` conversation="${input.conversationId}"`
      : "";
  const exactSourceAttribute =
    input.direction === "claude" && display.shortened
      ? ` from-alias="${input.sourceAlias}"`
      : "";
  const replyCommand =
    `embassy reply --conversation ${input.conversationId}` +
    ` --alias ${input.targetAlias}`;
  const hint =
    `<embassy-reply-hint conversation="${input.conversationId}"` +
    ` reply-as="${input.targetAlias}"${exactSourceAttribute}>` +
    `Reply by running \`${replyCommand}\` with the reply body on stdin. ` +
    "Route and hop policy are rechecked.</embassy-reply-hint>";
  const body = neutralizeReservedTags(input.body);
  const envelope =
    `<cross-session-message from-name="${fromName}"${conversationAttribute}>\n` +
    `${hint}\n${body}\n</cross-session-message>`;

  if (
    Buffer.byteLength(envelope, "utf8") > PROVENANCE_ENVELOPE_MAX_BYTES
  ) {
    envelopeTooLarge();
  }
  return envelope;
}
