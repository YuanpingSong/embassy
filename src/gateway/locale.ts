export const dashboardLocales = ["en", "zh-CN"] as const;

export type DashboardLocale = (typeof dashboardLocales)[number];

export function isDashboardLocale(value: unknown): value is DashboardLocale {
  return value === "en" || value === "zh-CN";
}

export function assertDashboardLocale(
  value: unknown,
): asserts value is DashboardLocale {
  if (!isDashboardLocale(value)) {
    throw new Error("DASHBOARD_LOCALE_UNSUPPORTED");
  }
}
