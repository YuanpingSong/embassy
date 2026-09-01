import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

import { gatewayCliCommands } from "../src/gateway/cli.js";
import type { DashboardLocale } from "../src/gateway/locale.js";
import {
  renderLiveDashboardAssets,
  type LiveDashboardAssets,
} from "../src/gateway/live-dashboard-assets.js";

// react@18.3.1 / react-dom@18.3.1 UMD production builds, vendored under
// assets/vendor/react. The pins are the tamper and drift detector: nothing
// but an intentional, reviewed version bump may change these digests.
const REACT_SHA256 =
  "d949f1c3687aedadcedac85261865f29b17cd273997e7f6b2bfc53b2f9d4c4dd";
const REACT_DOM_SHA256 =
  "35f4f974f4b2bcd44da73963347f8952e341f83909e4498227d4e26b98f66f0d";

const MAXIMUM_APP_BUNDLE_BYTES = 512 * 1024;

const VENDOR_DIRECTORY = new URL("../assets/vendor/react/", import.meta.url);
const SOURCE_DIRECTORY = new URL("../src/", import.meta.url);

const renderedAssets = new Map<DashboardLocale, LiveDashboardAssets>();

function assets(locale: DashboardLocale = "en"): LiveDashboardAssets {
  const cached = renderedAssets.get(locale);
  if (cached !== undefined) return cached;
  const rendered = renderLiveDashboardAssets(locale);
  renderedAssets.set(locale, rendered);
  return rendered;
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function collectSourceEnvironmentNames(): ReadonlySet<string> {
  const names = new Set<string>();
  const walk = (directory: URL): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      if (entry.isDirectory()) {
        // The dashboard app is the subject under test: a name it invents for
        // itself must never count as evidence that the gateway reads it.
        if (entry.name === "live-dashboard-app") continue;
        walk(new URL(`${entry.name}/`, directory));
        continue;
      }
      if (!entry.name.endsWith(".ts") && !entry.name.endsWith(".tsx")) continue;
      const text = readFileSync(new URL(entry.name, directory), "utf8");
      for (const match of text.matchAll(/EMBASSY_[A-Z0-9_]+/gu)) {
        names.add(match[0]);
      }
    }
  };
  walk(SOURCE_DIRECTORY);
  return names;
}

test("the shell and stylesheet reference no external, absolute, or protocol-relative URL", () => {
  const forbidden = [
    "http://",
    "https://",
    "//",
    "@import",
    "url(",
    "@font-face",
    "data:",
  ] as const;

  for (const locale of ["en", "zh-CN"] as const) {
    const shell = assets(locale).shellHtml;
    for (const token of forbidden) {
      assert.equal(
        shell.includes(token),
        false,
        `${locale} shell must not contain ${token}`,
      );
    }
  }

  const styleSheet = assets().styleSheet;
  assert.ok(styleSheet.length > 0, "the stylesheet must not be empty");
  for (const token of forbidden) {
    assert.equal(
      styleSheet.includes(token),
      false,
      `app.css must not contain ${token}`,
    );
  }
});

test("the boot script and the app bundle reach no external origin", () => {
  const forbidden = [
    "unpkg",
    "googleapis",
    "jsdelivr",
    "cdn.",
    "cdnjs",
    "esm.sh",
    "skypack",
    "importScripts",
    "navigator.sendBeacon",
    "sendBeacon(",
  ] as const;

  const scripts: ReadonlyArray<readonly [string, string]> = [
    ["client.js", assets().clientJavaScript],
    ["client.js (zh-CN)", assets("zh-CN").clientJavaScript],
    ["app.js", assets().appJavaScript],
  ];

  for (const [label, source] of scripts) {
    for (const token of forbidden) {
      assert.equal(
        source.includes(token),
        false,
        `${label} must not contain ${token}`,
      );
    }
    assert.doesNotMatch(
      source,
      /fetch\(\s*(["'`])\s*(?:[a-z][a-z0-9+.-]*:|\/\/)/iu,
      `${label} must not fetch an absolute URL`,
    );
    assert.doesNotMatch(
      source,
      /new\s+(?:WebSocket|EventSource|Worker|SharedWorker)\s*\(/u,
      `${label} must not open a non-fetch transport`,
    );
    assert.doesNotMatch(
      source,
      /<script|document\.write/u,
      `${label} must not inject script elements`,
    );
  }
});

test("the vendored React UMDs are the pinned 18.3.1 production bytes", () => {
  const fixtures = [
    {
      file: "react.production.min.js",
      digest: REACT_SHA256,
      served: assets().vendorReactJavaScript,
      marker: /\bversion="18\.3\.1"/u,
    },
    {
      file: "react-dom.production.min.js",
      digest: REACT_DOM_SHA256,
      served: assets().vendorReactDomJavaScript,
      marker: /reconcilerVersion:"18\.3\.1"/u,
    },
  ] as const;

  for (const fixture of fixtures) {
    const onDisk = readFileSync(new URL(fixture.file, VENDOR_DIRECTORY));
    assert.equal(
      sha256(onDisk),
      fixture.digest,
      `${fixture.file} does not match the pinned react@18.3.1 UMD digest`,
    );
    assert.equal(
      sha256(Buffer.from(fixture.served, "utf8")),
      fixture.digest,
      `${fixture.file} is not served byte-for-byte`,
    );
    assert.ok(
      fixture.served.includes("'use strict'"),
      `${fixture.file} must be the strict-mode production build`,
    );
    assert.match(fixture.served, fixture.marker, `${fixture.file} version marker`);
    assert.ok(
      fixture.served.includes("@license React"),
      `${fixture.file} must keep its license banner`,
    );
    assert.equal(
      fixture.served.includes("sourceMappingURL"),
      false,
      `${fixture.file} must not point at an external source map`,
    );
  }

  const license = readFileSync(new URL("LICENSE", VENDOR_DIRECTORY), "utf8");
  assert.match(license, /MIT License/u, "the vendored React LICENSE must ship");
});

test("the app bundle is a self-contained classic script", () => {
  const bundle = assets().appJavaScript;
  const bytes = Buffer.byteLength(bundle, "utf8");

  assert.doesNotMatch(
    bundle.trimStart(),
    /^(?:import|export)\s/u,
    "the bundle must not open with module syntax",
  );
  assert.doesNotMatch(
    bundle,
    /^(?:import|export)\s/mu,
    "module:\"none\" output must contain no import or export statement",
  );
  assert.doesNotMatch(bundle, /\bmodule\.exports\b/u, "no CommonJS exports");
  assert.doesNotMatch(bundle, /\brequire\(/u, "no CommonJS require");
  assert.ok(
    bundle.startsWith('"use strict";'),
    "the bundle must open in strict mode",
  );
  assert.ok(bundle.includes("var Embassy;"), "the Embassy namespace must exist");
  assert.match(
    bundle,
    /\(Embassy \|\| \(Embassy = \{\}\)\)/u,
    "namespace merging must survive the concatenation",
  );
  assert.ok(
    bundle.includes("ReactDOM.createRoot"),
    "the bundle must mount through ReactDOM.createRoot",
  );
  assert.ok(
    bytes < MAXIMUM_APP_BUNDLE_BYTES,
    `the bundle is ${bytes} bytes, over the ${MAXIMUM_APP_BUNDLE_BYTES} byte budget`,
  );
});

test("every embassy command in the bundle names a real CLI verb", () => {
  const bundle = assets().appJavaScript;
  const verbs = [...gatewayCliCommands].join("|");
  const allowed = new RegExp(
    `^(?:EMBASSY_[A-Z0-9_]+=\\S+ )?embassy (?:${verbs})\\b`,
    "u",
  );
  const commands = [
    ...bundle.matchAll(/(?:EMBASSY_[A-Z0-9_]+=\S+ )?\bembassy\s+\S+/gu),
  ].map((match) => match[0]);

  assert.ok(
    commands.length > 0,
    "the bundle must teach at least one real CLI command",
  );
  for (const command of commands) {
    assert.match(
      command,
      allowed,
      `"${command}" is not one of the real CLI verbs in src/gateway/cli.ts`,
    );
  }

  for (const phantom of [
    "embassy attest",
    "embassy restart",
    "embassy status --watch",
    "embassy pair",
    "embassy unpair",
  ]) {
    assert.equal(
      bundle.includes(phantom),
      false,
      `"${phantom.trim()}" does not exist and must never be taught`,
    );
  }
});

test("teaching commands only set environment variables the gateway reads", () => {
  const bundle = assets().appJavaScript;
  const known = collectSourceEnvironmentNames();
  const prefixed = [
    ...bundle.matchAll(/(EMBASSY_[A-Z0-9_]+)=\S+ embassy\s/gu),
  ].map((match) => match[1] ?? "");

  for (const name of prefixed) {
    assert.ok(
      known.has(name),
      `${name} is not read anywhere in src/; teach a real setting instead`,
    );
  }
});

test("every catalog key the bundle references exists in dashboardCopyKeys", async () => {
  const { dashboardCopyKeys } = await import("../src/gateway/dashboard-copy.js");
  const known = new Set<string>(dashboardCopyKeys);
  const bundle = assets().appJavaScript;
  // Dotted keys only, with a non-identifier character before `t(` so
  // `React.createElement("div"` never false-positives.
  const referenced = [
    ...bundle.matchAll(/[^A-Za-z0-9_$]t\("([a-z][a-zA-Z0-9]*(?:\.[a-zA-Z0-9]+)+)"/gu),
  ].map((match) => match[1] ?? "");
  assert.ok(referenced.length > 50, "expected the bundle to reference catalog keys");
  for (const key of referenced) {
    assert.ok(
      known.has(key),
      `bundle references "${key}" but it is missing from dashboardCopyKeys`,
    );
  }
});
