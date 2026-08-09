// State-chip normalization tables — the single source for chip kinds and
// hover-meaning i18n keys (integration spec §3). No per-tab copies.
//
// Honesty rules honored here:
//   H1 progress is never green; H2 delivered is `qualified` when the direction
//   is codex_to_claude (released ≠ read — driven by (state, direction), never
//   a "released" token); H3 unconfirmed/ambiguous (indeterminate/purple) are
//   distinct from failed (failure/red) and from the warning tier (coral);
//   H4 abandoned's meaning is safeErrorCode-conditional; H6 chip labels stay
//   English protocol tokens in both locales — only hover meaning localizes.
//
// Unknown tokens are loud, not silent: any unrecognized state maps to the
// dedicated `unknown` kind (dashed failure border) so a new enum value is
// noticed rather than camouflaged as `inert`.
namespace Embassy {
  export const CHIP_KINDS = [
    "positive",
    "qualified",
    "active",
    "progress",
    "warning",
    "indeterminate",
    "failure",
    "inert",
    "unknown",
  ] as const;

  export type ChipKind = (typeof CHIP_KINDS)[number];

  export type ChipDomain =
    | "delivery"
    | "route"
    | "peer"
    | "health"
    | "compatibility"
    | "overall"
    | "party"
    | "severity"
    | "connection";

  function tableLookup<Token extends string>(
    table: Readonly<Record<Token, ChipKind>>,
    state: string,
  ): ChipKind {
    return Object.prototype.hasOwnProperty.call(table, state)
      ? table[state as Token]
      : "unknown";
  }

  // §3.2 — the real closed 13 delivery states. `delivered` is refined to
  // `qualified` by direction in chipKindFor, never listed as a token here.
  const DELIVERY_CHIP_KINDS: Readonly<Record<DeliveryState, ChipKind>> = {
    queued: "progress",
    dispatching: "progress",
    transport_written: "progress",
    held: "progress",
    duplicate: "inert",
    delivered: "positive",
    unconfirmed: "indeterminate",
    ambiguous: "indeterminate",
    failed: "failure",
    expired: "failure",
    // Actionable (QUEUE_FULL / INVALID_DEADLINE) but a by-design refusal, not
    // a failure — coral warning tier, never failure-red (PM ruling).
    rejected: "warning",
    cancelled: "inert",
    abandoned: "inert",
  };

  // §3.3 — route states. Idle keeps the prototype's calm-neutral treatment
  // (soft-stone/slate progress chip), which is canonical.
  const ROUTE_CHIP_KINDS: Readonly<Record<RouteState, ChipKind>> = {
    idle: "progress",
    busy: "active",
    awaiting_approval: "warning",
    stale: "failure",
    offline: "failure",
    incompatible: "failure",
    disabled: "inert",
  };

  // §3.3 — peer states (offline is a candidate, not an error).
  const PEER_CHIP_KINDS: Readonly<Record<PublicAvailablePeerState, ChipKind>> = {
    idle: "progress",
    busy: "active",
    awaiting_approval: "warning",
    offline: "inert",
    incompatible: "failure",
  };

  const HEALTH_CHIP_KINDS: Readonly<Record<ConnectorHealth, ChipKind>> = {
    healthy: "positive",
    connecting: "progress",
    degraded: "warning",
    offline: "failure",
    incompatible: "failure",
  };

  const COMPATIBILITY_CHIP_KINDS: Readonly<
    Record<CompatibilityState, ChipKind>
  > = {
    compatible: "positive",
    unknown: "inert",
    expired: "warning",
    incompatible: "failure",
  };

  const OVERALL_CHIP_KINDS: Readonly<
    Record<DashboardViewModel["overall"], ChipKind>
  > = {
    ready: "positive",
    setup: "progress",
    attention: "failure",
  };

  const PARTY_CHIP_KINDS: Readonly<
    Record<DashboardExchangeParty["status"], ChipKind>
  > = {
    ready: "positive",
    busy: "active",
    waiting: "warning",
    missing: "inert",
    attention: "failure",
  };

  // Three distinct treatments (fixes the prototype's severity collapse).
  const SEVERITY_CHIP_KINDS: Readonly<Record<AlertSeverity, ChipKind>> = {
    info: "active",
    warning: "warning",
    error: "failure",
  };

  const CONNECTION_CHIP_KINDS: Readonly<Record<ConnectionState, ChipKind>> = {
    connected: "positive",
    connecting: "progress",
    paused: "inert",
    unavailable: "warning",
    disconnected: "warning",
    stopped: "warning",
  };

  /**
   * Delivery-state chip kind, including the H2 direction-driven rule:
   * delivered + codex_to_claude renders `qualified` (released ≠ read).
   */
  export function chipKindFor(
    state: string,
    direction?: MessageDirection,
    safeErrorCode?: string,
  ): ChipKind {
    if (state === "rejected" && safeErrorCode === "SENDER_NOT_PAIRED") {
      return "inert";
    }
    if (state === "delivered" && direction === "codex_to_claude") {
      return "qualified";
    }
    return tableLookup(DELIVERY_CHIP_KINDS, state);
  }

  export function routeChipKind(state: string): ChipKind {
    return tableLookup(ROUTE_CHIP_KINDS, state);
  }

  export function peerChipKind(state: string): ChipKind {
    return tableLookup(PEER_CHIP_KINDS, state);
  }

  export function healthChipKind(state: string): ChipKind {
    return tableLookup(HEALTH_CHIP_KINDS, state);
  }

  export function compatibilityChipKind(state: string): ChipKind {
    return tableLookup(COMPATIBILITY_CHIP_KINDS, state);
  }

  export function overallChipKind(state: string): ChipKind {
    return tableLookup(OVERALL_CHIP_KINDS, state);
  }

  export function partyChipKind(state: string): ChipKind {
    return tableLookup(PARTY_CHIP_KINDS, state);
  }

  export function severityChipKind(state: string): ChipKind {
    return tableLookup(SEVERITY_CHIP_KINDS, state);
  }

  export function connectionChipKind(state: string): ChipKind {
    return tableLookup(CONNECTION_CHIP_KINDS, state);
  }

  /** Single dispatcher used by shared.StateChip. */
  export function chipKindByDomain(
    domain: ChipDomain,
    state: string,
    direction?: MessageDirection,
  ): ChipKind {
    switch (domain) {
      case "delivery":
        return chipKindFor(state, direction);
      case "route":
        return routeChipKind(state);
      case "peer":
        return peerChipKind(state);
      case "health":
        return healthChipKind(state);
      case "compatibility":
        return compatibilityChipKind(state);
      case "overall":
        return overallChipKind(state);
      case "party":
        return partyChipKind(state);
      case "severity":
        return severityChipKind(state);
      case "connection":
        return connectionChipKind(state);
    }
  }

  /** snake_case protocol token → camelCase catalog-key segment. */
  export function camelCaseToken(token: string): string {
    return token.replace(/_([a-z])/g, (_match, character: string) =>
      character.toUpperCase(),
    );
  }

  /**
   * Hover-meaning catalog key for a delivery state (§3.4 tier 1).
   * `delivered` localizes by direction (H2); `abandoned` picks its annotation
   * by safeErrorCode (H4).
   */
  export function deliveryMeaningKey(
    state: string,
    safeErrorCode?: string,
    direction?: MessageDirection,
  ): string {
    switch (state) {
      case "queued":
        return "activity.meaning.queued";
      case "dispatching":
        return "activity.meaning.dispatching";
      case "transport_written":
        return "activity.meaning.transportWritten";
      case "held":
        return "activity.meaning.held";
      case "duplicate":
        return "activity.meaning.duplicate";
      case "delivered":
        return direction === "codex_to_claude"
          ? "activity.meaning.delivered.codexToClaude"
          : direction === "claude_to_codex"
            ? "activity.meaning.delivered.claudeToCodex"
            : "activity.meaning.delivered";
      case "unconfirmed":
        return "activity.meaning.unconfirmed";
      case "ambiguous":
        return "activity.meaning.ambiguous";
      case "failed":
        return "activity.meaning.failed";
      case "expired":
        return "activity.meaning.expired";
      case "rejected":
        return safeErrorCode === "SENDER_NOT_PAIRED"
          ? "activity.meaning.senderNotPaired"
          : "activity.meaning.rejected";
      case "cancelled":
        return "activity.meaning.cancelled";
      case "abandoned":
        switch (safeErrorCode) {
          case "CONTROLLER_RESTARTED":
            return "activity.meaning.abandoned.controllerRestarted";
          case "TRANSIENT_BODY_UNAVAILABLE":
            return "activity.meaning.abandoned.transientBody";
          case "ROUTE_UNREGISTERED":
          case "MESSAGE_EXPIRED":
            return "activity.meaning.abandoned.routeTerminated";
          default:
            return "activity.meaning.abandoned.generic";
        }
      default:
        return "activity.meaning.other";
    }
  }

  /** Hover-meaning catalog key per chip domain (§3.4 tiers 1 and 3). */
  export function meaningKeyFor(
    domain: ChipDomain,
    state: string,
    safeErrorCode?: string,
    direction?: MessageDirection,
  ): string {
    switch (domain) {
      case "delivery":
        return deliveryMeaningKey(state, safeErrorCode, direction);
      case "route":
        return `route.meaning.${camelCaseToken(state)}`;
      case "peer":
        return `peer.meaning.${camelCaseToken(state)}`;
      case "health":
        return `health.meaning.${camelCaseToken(state)}`;
      case "compatibility":
        return `compatibility.meaning.${camelCaseToken(state)}`;
      case "overall":
        return `overall.${camelCaseToken(state)}`;
      case "party":
        return `status.${camelCaseToken(state)}`;
      case "severity":
        return `severity.${camelCaseToken(state)}`;
      case "connection":
        return `live.connection.${state}`;
    }
  }
}
