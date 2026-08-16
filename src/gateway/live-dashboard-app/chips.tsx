// State presentation is authored in dashboard-model.ts and embedded in the
// boot payload. This bundle only performs guarded lookups over that vocabulary.
namespace Embassy {
  export const CHIP_KINDS: readonly ChipKind[] = [
    "positive",
    "qualified",
    "active",
    "progress",
    "warning",
    "indeterminate",
    "failure",
    "inert",
    "unknown",
  ];

  function tableValue<T>(
    table: Readonly<Record<string, T>>,
    key: string,
  ): T | undefined {
    return Object.prototype.hasOwnProperty.call(table, key)
      ? table[key]
      : undefined;
  }

  function presentation(domain: ChipDomain, state: string): ChipKind {
    const table = window.EMBASSY_BOOT.semantics.statePresentation[
      domain
    ] as Readonly<Record<string, Readonly<{ chip: ChipKind }>>>;
    return tableValue(table, state)?.chip ?? "unknown";
  }

  function deliveryOverride(
    table: Readonly<
      Record<string, Readonly<Record<string, ChipKind>>>
    >,
    state: string,
    discriminator: string | undefined,
  ): ChipKind | undefined {
    if (discriminator === undefined) return undefined;
    const byState = tableValue(table, state);
    return byState === undefined
      ? undefined
      : tableValue(byState, discriminator);
  }

  export function chipKindFor(
    state: string,
    direction?: MessageDirection,
    safeErrorCode?: string,
  ): ChipKind {
    const semantics = window.EMBASSY_BOOT.semantics;
    return (
      deliveryOverride(
        semantics.deliveryChipBySafeErrorCode,
        state,
        safeErrorCode,
      ) ??
      deliveryOverride(
        semantics.deliveryChipByTargetProvider,
        state,
        direction === undefined
          ? undefined
          : parseDirection(direction)?.targetProvider,
      ) ??
      presentation("delivery", state)
    );
  }

  export function routeChipKind(state: string): ChipKind {
    return presentation("route", state);
  }

  export function peerChipKind(state: string): ChipKind {
    return presentation("peer", state);
  }

  export function healthChipKind(state: string): ChipKind {
    return presentation("health", state);
  }

  export function overallChipKind(state: string): ChipKind {
    return presentation("overall", state);
  }

  export function partyChipKind(state: string): ChipKind {
    return presentation("party", state);
  }

  export function severityChipKind(state: string): ChipKind {
    return presentation("severity", state);
  }

  export function connectionChipKind(state: string): ChipKind {
    return presentation("connection", state);
  }

  export function chipKindByDomain(
    domain: ChipDomain,
    state: string,
    direction?: MessageDirection,
  ): ChipKind {
    return domain === "delivery"
      ? chipKindFor(state, direction)
      : presentation(domain, state);
  }

  export function camelCaseToken(token: string): string {
    return token.replace(/_([a-z])/g, (_match, character: string) =>
      character.toUpperCase(),
    );
  }

  export function deliveryMeaningKey(
    state: string,
    direction?: MessageDirection,
    safeErrorCode?: string,
  ): string {
    const semantics = window.EMBASSY_BOOT.semantics;
    if (state === "rejected" && safeErrorCode === "SENDER_NOT_PAIRED") {
      return semantics.deliveryMeaningBySafeErrorCode.SENDER_NOT_PAIRED;
    }
    if (state === "delivered" && direction !== undefined) {
      const target = parseDirection(direction)?.targetProvider;
      if (target !== undefined) {
        return semantics.deliveryMeaningByTargetProvider[target];
      }
    }
    if (state === "abandoned" && safeErrorCode !== undefined) {
      const byCode = semantics.deliveryMeaningBySafeErrorCode as Readonly<
        Record<string, string>
      >;
      return tableValue(byCode, safeErrorCode) ??
        semantics.deliveryMeaningKeys.abandoned;
    }
    const byState = semantics.deliveryMeaningKeys as Readonly<
      Record<string, string>
    >;
    return tableValue(byState, state) ?? "activity.meaning.other";
  }

  export function meaningKeyFor(
    domain: ChipDomain,
    state: string,
    safeErrorCode?: string,
    direction?: MessageDirection,
  ): string {
    if (domain === "delivery") {
      return deliveryMeaningKey(state, direction, safeErrorCode);
    }
    switch (domain) {
      case "route":
        return `route.meaning.${camelCaseToken(state)}`;
      case "peer":
        return `peer.meaning.${camelCaseToken(state)}`;
      case "health":
        return `health.meaning.${camelCaseToken(state)}`;
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
