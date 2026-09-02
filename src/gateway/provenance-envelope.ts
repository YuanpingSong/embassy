import { createHash } from "node:crypto";

import { BridgeError } from "../errors.js";
import type { GatewayProvider } from "./types.js";

export const PROVENANCE_RAW_BODY_MAX_BYTES = 16 * 1024;
export const PROVENANCE_ENVELOPE_MAX_BYTES = 64 * 1024;

const ALIAS_PATTERN =
  /^[a-z][a-z0-9_-]{0,31}@[a-z0-9](?:[a-z0-9.-]{0,61}[a-z0-9])?$/;
const CONVERSATION_ID_PATTERN = /^conv_[A-Za-z0-9_-]{16,64}$/;
const RESERVED_TAG_PATTERN =
  /<(?=\/?(?:cross-session-message|embassy-reply-hint|embassy-queued-ahead)(?:[>\s/]|$))/giu;
const CLAUDE_FROM_NAME_MAX_CODEPOINTS = 64;
const LONG_ALIAS_HASH_HEX_LENGTH = 16;

type ProvenanceRecipientProfile = Readonly<{
  fromNameMaxCodepoints?: number;
  emitConversationAttribute: boolean;
  allowQueuedAhead: boolean;
}>;

const PROVENANCE_RECIPIENT_PROFILE_VALUES = {
  claude: Object.freeze({
    fromNameMaxCodepoints: CLAUDE_FROM_NAME_MAX_CODEPOINTS,
    emitConversationAttribute: false,
    allowQueuedAhead: false,
  }),
  codex: Object.freeze({
    emitConversationAttribute: true,
    allowQueuedAhead: true,
  }),
  peer: Object.freeze({
    emitConversationAttribute: true,
    allowQueuedAhead: false,
  }),
} satisfies Record<GatewayProvider, ProvenanceRecipientProfile>;

const PROVENANCE_RECIPIENT_PROFILES: Readonly<
  Record<GatewayProvider, ProvenanceRecipientProfile>
> = Object.freeze(PROVENANCE_RECIPIENT_PROFILE_VALUES);

export type ComposeProvenanceEnvelopeInput = Readonly<{
  sourceProvider: GatewayProvider;
  recipientProvider: GatewayProvider;
  sourceAlias: string;
  targetAlias: string;
  conversationId: string;
  body: string;
  /** Older accepted rows on this exact route when a STEER is injected. */
  queuedAhead?: number;
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

function isGatewayProvider(value: unknown): value is GatewayProvider {
  return (
    typeof value === "string" &&
    Object.hasOwn(PROVENANCE_RECIPIENT_PROFILES, value)
  );
}

function validateInput(input: ComposeProvenanceEnvelopeInput): void {
  if (
    typeof input !== "object" ||
    input === null ||
    !isGatewayProvider(input.sourceProvider) ||
    !isGatewayProvider(input.recipientProvider) ||
    (input.sourceProvider === input.recipientProvider &&
      input.sourceProvider !== "peer") ||
    typeof input.sourceAlias !== "string" ||
    !ALIAS_PATTERN.test(input.sourceAlias) ||
    typeof input.targetAlias !== "string" ||
    !ALIAS_PATTERN.test(input.targetAlias) ||
    typeof input.conversationId !== "string" ||
    !CONVERSATION_ID_PATTERN.test(input.conversationId) ||
    typeof input.body !== "string" ||
    (input.queuedAhead !== undefined &&
      (!PROVENANCE_RECIPIENT_PROFILES[input.recipientProvider]
        .allowQueuedAhead ||
        !Number.isSafeInteger(input.queuedAhead) ||
        input.queuedAhead < 1))
  ) {
    invalidEnvelope();
  }

  if (Buffer.byteLength(input.body, "utf8") > PROVENANCE_RAW_BODY_MAX_BYTES) {
    envelopeTooLarge();
  }
}

function boundedDisplayAlias(alias: string, maximumCodepoints: number): {
  displayAlias: string;
  shortened: boolean;
} {
  const codepoints = [...alias];
  if (codepoints.length <= maximumCodepoints) {
    return { displayAlias: alias, shortened: false };
  }

  const digest = createHash("sha256")
    .update(alias, "utf8")
    .digest("hex")
    .slice(0, LONG_ALIAS_HASH_HEX_LENGTH);
  const prefixCodepoints =
    maximumCodepoints - LONG_ALIAS_HASH_HEX_LENGTH - 1;
  return {
    displayAlias: `${codepoints.slice(0, prefixCodepoints).join("")}~${digest}`,
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

  const profile = PROVENANCE_RECIPIENT_PROFILES[input.recipientProvider];
  const display =
    profile.fromNameMaxCodepoints === undefined
      ? { displayAlias: input.sourceAlias, shortened: false }
      : boundedDisplayAlias(
          input.sourceAlias,
          profile.fromNameMaxCodepoints,
        );
  const fromName =
    profile.fromNameMaxCodepoints === undefined
      ? input.sourceAlias
      : display.displayAlias;
  const conversationAttribute =
    profile.emitConversationAttribute
      ? ` conversation="${input.conversationId}"`
      : "";
  const exactSourceAttribute =
    profile.fromNameMaxCodepoints !== undefined && display.shortened
      ? ` from-alias="${input.sourceAlias}"`
      : "";
  const replyCommand =
    `embassy send --conversation ${input.conversationId}` +
    ` --from ${input.targetAlias}`;
  const hint =
    `<embassy-reply-hint conversation="${input.conversationId}"` +
    ` reply-as="${input.targetAlias}"${exactSourceAttribute}` +
    ` from-provider="${input.sourceProvider}">` +
    `Reply by running \`${replyCommand}\` with the reply body on stdin. ` +
    "Caller, conversation, and route policy are rechecked.</embassy-reply-hint>";
  const queuedAheadMarker =
    input.queuedAhead === undefined
      ? ""
      : `\n<embassy-queued-ahead count="${input.queuedAhead}">` +
        `${input.queuedAhead} earlier ${input.queuedAhead === 1 ? "message is" : "messages are"} ` +
        "queued for this route and will arrive at your next turn " +
        "boundaries.</embassy-queued-ahead>";
  const body = neutralizeReservedTags(input.body);
  const envelope =
    `<cross-session-message from-name="${fromName}"${conversationAttribute}>\n` +
    `${hint}${queuedAheadMarker}\n${body}\n</cross-session-message>`;

  if (
    Buffer.byteLength(envelope, "utf8") > PROVENANCE_ENVELOPE_MAX_BYTES
  ) {
    envelopeTooLarge();
  }
  return envelope;
}
