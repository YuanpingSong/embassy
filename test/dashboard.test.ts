import assert from "node:assert/strict";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { test } from "node:test";
import os from "node:os";
import path from "node:path";

import { dashboardCopyEn } from "../src/gateway/dashboard-copy.en.js";
import { dashboardCopyZhCn } from "../src/gateway/dashboard-copy.zh-CN.js";
import {
  assertDashboardLocale,
  dashboardCopyKeys,
  dashboardLocales,
  isDashboardLocale,
} from "../src/gateway/dashboard-copy.js";
import {
  DASHBOARD_ALERT_LIMIT,
  DASHBOARD_AVAILABLE_PEER_LIMIT,
  DASHBOARD_CONNECTOR_LIMIT,
  DASHBOARD_FILE_NAME,
  DASHBOARD_MAX_HTML_BYTES,
  DASHBOARD_MESSAGE_LIMIT,
  DASHBOARD_ROUTE_LIMIT,
  DASHBOARD_ZH_CN_FILE_NAME,
  escapeDashboardHtml,
  renderDashboardHtml,
  writeDashboardSnapshot,
  type DashboardSnapshot,
} from "../src/gateway/dashboard.js";
import { buildDashboardViewModel } from "../src/gateway/dashboard-model.js";
import { dashboardFixture, routeCounters } from "./dashboard-fixture.js";

test("dashboard catalogs have exact key parity", () => {
  const expected = [...dashboardCopyKeys].sort();
  assert.deepEqual(Object.keys(dashboardCopyEn).sort(), expected);
  assert.deepEqual(Object.keys(dashboardCopyZhCn).sort(), expected);
  for (const key of dashboardCopyKeys) {
    assert.ok(dashboardCopyEn[key].trim().length > 0, `English ${key}`);
    assert.ok(dashboardCopyZhCn[key].trim().length > 0, `Chinese ${key}`);
    const placeholders = (value: string): string[] =>
      [...value.matchAll(/\{([a-zA-Z][a-zA-Z0-9]*)\}/g)]
        .map((match) => match[1]!)
        .sort();
    assert.deepEqual(
      placeholders(dashboardCopyZhCn[key]),
      placeholders(dashboardCopyEn[key]),
      `placeholder parity for ${key}`,
    );
  }
});

test("dashboard locale grammar is one exact shared allowlist", () => {
  assert.deepEqual(dashboardLocales, ["en", "zh-CN"]);
  for (const locale of dashboardLocales) {
    assert.equal(isDashboardLocale(locale), true);
    assert.doesNotThrow(() => assertDashboardLocale(locale));
  }
  for (const value of [undefined, null, "", "EN", "zh-cn", "zh-CN ", 1]) {
    assert.equal(isDashboardLocale(value), false);
    assert.throws(() => assertDashboardLocale(value), {
      message: "DASHBOARD_LOCALE_UNSUPPORTED",
    });
  }
});

test("English and Chinese render one semantic model with reciprocal local links", () => {
  const snapshot = dashboardFixture();
  const model = buildDashboardViewModel(snapshot);
  const en = renderDashboardHtml(snapshot, { locale: "en", refreshSeconds: 2 });
  const zh = renderDashboardHtml(snapshot, { locale: "zh-CN" });

  assert.equal(renderDashboardHtml(snapshot, { locale: "en" }), en);
  assert.match(en, /^<!doctype html>\n<html lang="en">/);
  assert.match(zh, /^<!doctype html>\n<html lang="zh-CN">/);
  assert.match(en, new RegExp(`href="\\./${DASHBOARD_ZH_CN_FILE_NAME}"`));
  assert.match(zh, new RegExp(`href="\\./${DASHBOARD_FILE_NAME}"`));
  assert.match(en, /lang="zh-CN" hreflang="zh-CN"/);
  assert.match(zh, /lang="en" hreflang="en"/);
  assert.equal((en.match(/data-dashboard-row="message-summary"/g) ?? []).length, model.activity.length);
  assert.equal((zh.match(/data-dashboard-row="message-summary"/g) ?? []).length, model.activity.length);
  for (const state of model.activity.map((message) => message.state)) {
    assert.equal((en.match(new RegExp(`data-delivery-state="${state}"`, "g")) ?? []).length, 1);
    assert.equal((zh.match(new RegExp(`data-delivery-state="${state}"`, "g")) ?? []).length, 1);
  }
  assert.ok(Buffer.byteLength(en, "utf8") <= DASHBOARD_MAX_HTML_BYTES);
  assert.ok(Buffer.byteLength(zh, "utf8") <= DASHBOARD_MAX_HTML_BYTES);
});

test("runtime locale selection rejects every value outside the closed allowlist", () => {
  const hostile = `zh-CN\"><script>LOCALE_ATTACK</script>`;
  assert.throws(
    () =>
      renderDashboardHtml(dashboardFixture(), {
        locale: hostile as "en",
      }),
    { message: "DASHBOARD_LOCALE_UNSUPPORTED" },
  );
  assert.throws(
    () =>
      renderDashboardHtml(dashboardFixture(), {
        locale: "EN" as "en",
      }),
    { message: "DASHBOARD_LOCALE_UNSUPPORTED" },
  );
});

test("dashboard is an inert self-contained snapshot with strict accessibility floors", () => {
  const html = renderDashboardHtml(dashboardFixture());
  assert.match(html, /default-src &#39;none&#39;|default-src 'none'/);
  assert.match(html, /connect-src &#39;none&#39;|connect-src 'none'/);
  assert.match(html, /form-action &#39;none&#39;|form-action 'none'/);
  assert.match(html, /<a class="skip-link" href="#main">/);
  assert.match(html, /<main id="main">/);
  assert.match(html, /@media \(max-width: 560px\)/);
  assert.match(html, /@media \(forced-colors: active\)/);
  assert.match(html, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(html, /\.register-grid > section \{ min-width: 0; \}/);
  assert.match(html, /tabindex="0" role="region"/);
  assert.match(
    html,
    /<details class="section diagnostics"[^>]*aria-labelledby="diagnostics-title"[^>]*>/,
  );
  assert.match(html, /<summary><h2 id="diagnostics-title">/);
  assert.match(html, /class="disclosure-icon" aria-hidden="true"/);
  assert.equal(html.includes("strong::before"), false);
  assert.equal(html.includes("<script"), false);
  assert.equal(html.includes("<form"), false);
  assert.equal(html.includes("javascript:"), false);
  assert.equal(html.includes("http://"), false);
  assert.equal(html.includes("https://"), false);
  assert.equal(html.includes("src="), false);
  assert.equal(html.includes("localStorage"), false);
  assert.equal(html.includes("sessionStorage"), false);
  assert.equal(html.includes("document.cookie"), false);
  assert.equal(html.includes('http-equiv="refresh"'), false);
  assert.equal(html.includes("onclick="), false);
  assert.equal(html.includes(">Copy<"), false);
});

test("information architecture is ordered and calm when no alert exists", () => {
  const html = renderDashboardHtml(dashboardFixture());
  const exchange = html.indexOf('id="exchange-title"');
  const transit = html.indexOf('id="transit-title"');
  const activity = html.indexOf('id="activity-title"');
  const sessions = html.indexOf('id="sessions-title"');
  const diagnostics = html.indexOf('class="section diagnostics"');
  assert.ok(exchange > 0 && transit > exchange && activity > transit && sessions > activity && diagnostics > sessions);
  assert.equal(html.includes('id="attention-title"'), false);
  assert.match(html, /Two directions, two explicit boundaries/);
  assert.match(html, /Claude sessions/);
  assert.match(html, /Local pouch/);
  assert.match(html, /Codex tasks/);
  assert.match(html, /Compatibility &amp; system details/);
  assert.match(html, /<details class="section diagnostics"/);
});

test("delivery language preserves delivered, unconfirmed, and ambiguous semantics", () => {
  const en = renderDashboardHtml(dashboardFixture(), { locale: "en" });
  assert.match(en, /Codex App Server accepted the turn/);
  assert.match(en, /does not mean the model completed or acted on it/);
  assert.match(en, /transport write completed, but terminal native evidence was unavailable/i);
  assert.match(en, /Inspect the recipient before retrying/);
  assert.match(en, /outcome is unknown after an uncertain write/i);
  assert.match(en, /Do not retry automatically/);
  assert.match(en, /data-delivery-state="delivered"/);
  assert.match(en, /data-delivery-state="unconfirmed"/);
  assert.match(en, /data-delivery-state="ambiguous"/);

  const zh = renderDashboardHtml(dashboardFixture(), { locale: "zh-CN" });
  assert.match(zh, /Codex App Server 已接受该轮输入/);
  assert.match(zh, /不表示模型已经完成或处理该输入/);
  assert.match(zh, /重试前请检查接收方/);
  assert.match(zh, /请勿自动重试/);

  const released = dashboardFixture();
  released.messages = released.messages.map((message) => {
    if (message.messageIdSuffix !== "c0ffee") return message;
    const { safeErrorCode: _safeErrorCode, ...withoutSafeErrorCode } = message;
    return { ...withoutSafeErrorCode, state: "delivered" as const };
  });
  const releasedEn = renderDashboardHtml(released, { locale: "en" });
  assert.match(releasedEn, /Claude returned a terminal released receipt/);
  assert.match(releasedEn, /message entered the recipient queue/);
  assert.match(releasedEn, /does not mean the model read or acted on it/);
  const releasedZh = renderDashboardHtml(released, { locale: "zh-CN" });
  assert.match(releasedZh, /Claude 返回了终结 released 回执/);
  assert.match(releasedZh, /不表示模型已经读取或处理该消息/);
});

test("small dashboard text and quiet pills meet the 4.5:1 light-theme contrast floor", () => {
  const html = renderDashboardHtml(dashboardFixture());
  const color = (name: string): string => {
    const match = html.match(new RegExp(`--${name}: #([0-9a-f]{6});`));
    assert.ok(match, name);
    return match[1]!;
  };
  const luminance = (hex: string): number => {
    const channels = hex
      .match(/../g)!
      .map((entry) => Number.parseInt(entry, 16) / 255)
      .map((entry) =>
        entry <= 0.04045
          ? entry / 12.92
          : ((entry + 0.055) / 1.055) ** 2.4,
      );
    return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
  };
  const ratio = (foreground: string, background: string): number => {
    const left = luminance(foreground);
    const right = luminance(background);
    return (Math.max(left, right) + 0.05) / (Math.min(left, right) + 0.05);
  };
  assert.ok(ratio(color("muted"), color("paper-deep")) >= 4.5);
  assert.ok(ratio(color("quiet"), color("quiet-soft")) >= 4.5);
});

test("canonical mark uses two facing ink arcs and only a cinnabar center", () => {
  const html = renderDashboardHtml(dashboardFixture());
  assert.match(
    html,
    /\.brand-mark::before, \.seal-mark::before \{ left: 20%; border-right: 1px solid var\(--ink\); \}/,
  );
  assert.match(
    html,
    /\.brand-mark::after, \.seal-mark::after \{ right: 20%; border-left: 1px solid var\(--ink\); \}/,
  );
  assert.match(
    html,
    /\.brand-mark span, \.seal-mark span \{[^}]*background: var\(--seal\);/,
  );
  assert.equal(html.includes("rotate(36deg)"), false);
});

test("dashboard escapes public strings and allowlists public fields", () => {
  const payload = `alias<&"'>PAYLOAD_END`;
  const snapshot = dashboardFixture() as DashboardSnapshot & Record<string, unknown>;
  snapshot["nativeThreadId"] = "THREAD_ID_SECRET";
  snapshot["rawError"] = "RAW_ERROR_SECRET";
  snapshot.routes = [
    {
      ...snapshot.routes[0]!,
      alias: payload,
      host: `<img src=x onerror="HOST_ATTACK">`,
      sessionId: "SESSION_ID_SECRET",
      routeHandle: "ROUTE_HANDLE_SECRET",
    } as DashboardSnapshot["routes"][number],
  ];
  snapshot.connectors = [
    {
      ...snapshot.connectors[0]!,
      host: payload,
      protocol: `peer/1"><img src=x onerror=PROTOCOL_ATTACK>`,
      safeErrorCode: "not safe <RAW_DIAGNOSTIC>",
      socketPath: "SOCKET_PATH_SECRET",
    } as DashboardSnapshot["connectors"][number],
  ];
  snapshot.messages = [
    {
      ...snapshot.messages[0]!,
      sourceAlias: payload,
      targetAlias: `<svg onload="MESSAGE_ATTACK">`,
      messageIdSuffix: "LEAK_THIS_SUFFIX",
      body: "MESSAGE_BODY_SECRET",
      prompt: "PROMPT_SECRET",
    } as DashboardSnapshot["messages"][number],
  ];
  snapshot.availablePeers = [
    {
      ...snapshot.availablePeers[0]!,
      cwd: "PEER_CWD_SECRET",
    } as DashboardSnapshot["availablePeers"][number],
  ];

  const html = renderDashboardHtml(snapshot);
  assert.equal(html.includes(payload), false);
  assert.ok(html.includes(escapeDashboardHtml(payload)));
  assert.ok(html.includes("&lt;img src=x onerror=&quot;HOST_ATTACK&quot;&gt;"));
  assert.ok(html.includes("&lt;svg onload=&quot;MESSAGE_ATTACK&quot;&gt;"));
  for (const sentinel of [
    "THREAD_ID_SECRET",
    "RAW_ERROR_SECRET",
    "SESSION_ID_SECRET",
    "ROUTE_HANDLE_SECRET",
    "PROTOCOL_ATTACK",
    "RAW_DIAGNOSTIC",
    "SOCKET_PATH_SECRET",
    "LEAK_THIS_SUFFIX",
    "MESSAGE_BODY_SECRET",
    "PROMPT_SECRET",
    "PEER_CWD_SECRET",
  ]) {
    assert.equal(html.includes(sentinel), false, sentinel);
  }
});

test("dense dashboard projections remain independently bounded in both locales", () => {
  const snapshot = dashboardFixture();
  const route = snapshot.routes[0]!;
  snapshot.connectors = Array.from({ length: DASHBOARD_CONNECTOR_LIMIT + 4 }, (_, index) => ({
    ...snapshot.connectors[index % 2]!,
    host: `host-${String(index).padStart(2, "0")}.local`,
  }));
  snapshot.availablePeers = Array.from({ length: DASHBOARD_AVAILABLE_PEER_LIMIT + 4 }, (_, index) => ({
    alias: `peer${String(index).padStart(4, "0")}@host.local`,
    provider: "claude" as const,
    host: "host.local",
    state: "idle" as const,
    compatibility: "compatible" as const,
    selected: index === 0,
  }));
  snapshot.routes = Array.from({ length: DASHBOARD_ROUTE_LIMIT + 4 }, (_, index) => ({
    ...route,
    alias: `route${String(index).padStart(4, "0")}@host.local`,
    provider: index % 2 === 0 ? ("codex" as const) : ("claude" as const),
    host: "host.local",
    queueDepth: 0,
    counters: routeCounters(),
  }));
  snapshot.messages = Array.from({ length: DASHBOARD_MESSAGE_LIMIT + 4 }, (_, index) => ({
    sequence: index + 1,
    timestamp: new Date(Date.UTC(2026, 7, 8, 10, 0, index)).toISOString(),
    messageIdSuffix: index.toString(16).padStart(6, "0"),
    direction: "claude_to_codex" as const,
    sourceAlias: `peer${String(index).padStart(4, "0")}@host.local`,
    targetAlias: `route${String(index).padStart(4, "0")}@host.local`,
    state: "delivered" as const,
    bytes: 16_384,
    hopCount: 0,
  }));
  snapshot.alerts = Array.from({ length: DASHBOARD_ALERT_LIMIT + 4 }, (_, index) => ({
    code: "UNMAPPED_SAFE_ALERT",
    severity: "warning" as const,
    timestamp: "2026-08-08T11:59:59.000Z",
    provider: index % 2 === 0 ? ("codex" as const) : ("claude" as const),
    host: "host.local",
    alias: `route${String(index).padStart(4, "0")}@host.local`,
  }));

  for (const locale of ["en", "zh-CN"] as const) {
    const html = renderDashboardHtml(snapshot, { locale });
    assert.ok(Buffer.byteLength(html, "utf8") <= DASHBOARD_MAX_HTML_BYTES, locale);
    assert.equal((html.match(/data-dashboard-row="message-summary"/g) ?? []).length, DASHBOARD_MESSAGE_LIMIT);
  }
  const model = buildDashboardViewModel(snapshot);
  assert.equal(model.omissions.connectors, 4);
  assert.equal(model.omissions.availablePeers, 4);
  assert.equal(model.omissions.routes, 4);
  assert.equal(model.omissions.upstreamMessageEvents, 0);
  assert.equal(model.omissions.messageGroups, 4);
  assert.equal(model.omissions.messageEvents, 0);
  assert.equal(model.omissions.upstreamAlerts, 0);
  assert.equal(model.omissions.attentionItems, 4);
});

test("diagnostics disclose every lifetime accounting field", () => {
  const html = renderDashboardHtml(dashboardFixture());
  for (const label of [
    "Accepted",
    "Duplicates",
    "Delivered",
    "Unconfirmed",
    "Ambiguous",
    "Failed",
    "Expired",
    "Cancelled",
    "Abandoned",
    "Rejected",
    "Bytes accepted",
    "Bytes queued",
  ]) {
    assert.match(html, new RegExp(`<dt>${label}</dt>`), label);
  }
});

test("publisher prepares and atomically replaces both private locale files", async () => {
  const root = await mkdtemp(path.join(await realpath(os.tmpdir()), "embassy-dashboard-"));
  const stateDirectory = path.join(root, "state");
  try {
    await mkdir(stateDirectory, { mode: 0o700 });
    await chmod(stateDirectory, 0o700);
    const snapshot = dashboardFixture();
    const outputPath = await writeDashboardSnapshot(stateDirectory, snapshot);
    const enPath = path.join(stateDirectory, DASHBOARD_FILE_NAME);
    const zhPath = path.join(stateDirectory, DASHBOARD_ZH_CN_FILE_NAME);
    assert.equal(outputPath, enPath);
    assert.equal((await lstat(enPath)).mode & 0o777, 0o600);
    assert.equal((await lstat(zhPath)).mode & 0o777, 0o600);
    assert.equal(await readFile(enPath, "utf8"), renderDashboardHtml(snapshot, { locale: "en" }));
    assert.equal(await readFile(zhPath, "utf8"), renderDashboardHtml(snapshot, { locale: "zh-CN" }));
    assert.deepEqual((await readdir(stateDirectory)).sort(), [DASHBOARD_FILE_NAME, DASHBOARD_ZH_CN_FILE_NAME].sort());

    snapshot.health = "degraded";
    snapshot.alerts = [{ code: "ADAPTER_DEGRADED", severity: "warning", timestamp: snapshot.generatedAt }];
    await writeDashboardSnapshot(stateDirectory, snapshot);
    assert.match(await readFile(enPath, "utf8"), /The exchange is degraded/);
    assert.match(await readFile(zhPath, "utf8"), /交换状态降级/);
    assert.equal((await lstat(enPath)).mode & 0o777, 0o600);
    assert.equal((await lstat(zhPath)).mode & 0o777, 0o600);
    assert.equal((await readdir(stateDirectory)).some((name) => name.endsWith(".tmp")), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("publisher rejects unsafe directories and either locale symlink before replacement", async () => {
  const root = await mkdtemp(path.join(await realpath(os.tmpdir()), "embassy-dashboard-unsafe-"));
  const privateDirectory = path.join(root, "private");
  const publicDirectory = path.join(root, "public");
  const linkedDirectory = path.join(root, "linked");
  try {
    await mkdir(privateDirectory, { mode: 0o700 });
    await chmod(privateDirectory, 0o700);
    await mkdir(publicDirectory, { mode: 0o755 });
    await chmod(publicDirectory, 0o755);
    await symlink(privateDirectory, linkedDirectory);
    await assert.rejects(writeDashboardSnapshot(publicDirectory, dashboardFixture()), { message: "DASHBOARD_STATE_DIRECTORY_UNSAFE" });
    await assert.rejects(writeDashboardSnapshot(linkedDirectory, dashboardFixture()), { message: "DASHBOARD_STATE_DIRECTORY_UNSAFE" });

    const enPath = path.join(privateDirectory, DASHBOARD_FILE_NAME);
    await writeFile(enPath, "old English", { mode: 0o600 });
    const outside = path.join(root, "outside.html");
    await writeFile(outside, "preserve me", { mode: 0o600 });
    await symlink(outside, path.join(privateDirectory, DASHBOARD_ZH_CN_FILE_NAME));
    await assert.rejects(writeDashboardSnapshot(privateDirectory, dashboardFixture()), { message: "DASHBOARD_TARGET_UNSAFE" });
    assert.equal(await readFile(enPath, "utf8"), "old English");
    assert.equal(await readFile(outside, "utf8"), "preserve me");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
