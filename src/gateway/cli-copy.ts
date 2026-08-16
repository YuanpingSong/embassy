import { cliCopyEn } from "./cli-copy.en.js";
import { cliCopyZhCn } from "./cli-copy.zh-CN.js";
import type { DashboardLocale } from "./locale.js";

export const cliCopyKeys = [
  "help.usage",
  "hint.dashboardLiveRequired",
  "hint.dashboardPortInUse",
  "hint.controlInvalidResponse",
  "hint.messageTooLarge",
  "hint.progressWatchOwnerConflict",
  "hint.codexSplitBrain",
  "hint.codexOrphaned",
  "error.input",
  "error.decision",
  "error.unavailable",
  "error.ambiguous",
  "error.failure",
  "error.unsafe",
  "error.tokenUnknown",
  "error.deliveryTimeout",
] as const;

export type CliCopyKey = (typeof cliCopyKeys)[number];
export type CliCopy = Readonly<Record<CliCopyKey, string>>;
export type CliStderrKind = {
  [Key in CliCopyKey]: Key extends `error.${infer Kind}` ? Kind : never;
}[CliCopyKey];

export function getCliCopy(locale: DashboardLocale): CliCopy {
  return locale === "zh-CN" ? cliCopyZhCn : cliCopyEn;
}
