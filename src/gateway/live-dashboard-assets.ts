import { readFileSync } from "node:fs";

import { BridgeError } from "../errors.js";
import {
  assertDashboardLocale,
  getDashboardCopy,
  type DashboardLocale,
} from "./dashboard-copy.js";
import { DASHBOARD_SEMANTICS } from "./dashboard-model.js";

export type LiveDashboardAssets = Readonly<{
  shellHtml: string;
  clientJavaScript: string;
  styleSheet: string;
  appJavaScript: string;
  vendorReactJavaScript: string;
  vendorReactDomJavaScript: string;
}>;

const APP_JAVASCRIPT_CANDIDATES: readonly string[] = [
  "./live-dashboard-app/app.js",
  "../../dist/src/gateway/live-dashboard-app/app.js",
];

const VENDOR_REACT_CANDIDATES: readonly string[] = [
  "../../../assets/vendor/react/react.production.min.js",
  "../../assets/vendor/react/react.production.min.js",
];

const VENDOR_REACT_DOM_CANDIDATES: readonly string[] = [
  "../../../assets/vendor/react/react-dom.production.min.js",
  "../../assets/vendor/react/react-dom.production.min.js",
];

const STYLE_SHEET_CANDIDATES: readonly string[] = [
  "../../../assets/live-dashboard/app.css",
  "../../assets/live-dashboard/app.css",
];

function readBundledAsset(candidates: readonly string[]): string {
  for (const rel of candidates) {
    try {
      return readFileSync(new URL(rel, import.meta.url), "utf8");
    } catch {
      // Try the next candidate location.
    }
  }
  throw new BridgeError(
    "LIVE_DASHBOARD_ASSET_MISSING",
    `A bundled live dashboard asset is missing; looked for: ${candidates.join(", ")} (relative to ${import.meta.url}).`,
  );
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function shell(locale: DashboardLocale): string {
  const copy = getDashboardCopy(locale);
  return `<!doctype html>
<html lang="${locale}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(copy["live.title"])}</title>
<link rel="stylesheet" href="app.css">
<script defer src="react.js"></script>
<script defer src="react-dom.js"></script>
<script defer src="client.js"></script>
<script defer src="app.js"></script>
</head><body><div id="root" aria-live="off"></div>
<noscript>${escapeHtml(copy["live.noscript"])}</noscript></body></html>`;
}

function client(locale: DashboardLocale): string {
  const copies = {
    en: getDashboardCopy("en"),
    "zh-CN": getDashboardCopy("zh-CN"),
  };
  return `"use strict";
window.EMBASSY_BOOT=Object.freeze({locale:${JSON.stringify(locale)},copy:Object.freeze({en:Object.freeze(${JSON.stringify(copies.en)}),"zh-CN":Object.freeze(${JSON.stringify(copies["zh-CN"])})}),semantics:Object.freeze(${JSON.stringify(DASHBOARD_SEMANTICS)})});
`;
}

export function renderLiveDashboardAssets(
  locale: DashboardLocale,
): LiveDashboardAssets {
  assertDashboardLocale(locale);
  return {
    shellHtml: shell(locale),
    clientJavaScript: client(locale),
    styleSheet: readBundledAsset(STYLE_SHEET_CANDIDATES),
    appJavaScript: readBundledAsset(APP_JAVASCRIPT_CANDIDATES),
    vendorReactJavaScript: readBundledAsset(VENDOR_REACT_CANDIDATES),
    vendorReactDomJavaScript: readBundledAsset(VENDOR_REACT_DOM_CANDIDATES),
  };
}
