import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import stringWidth from "string-width";
import { renderTui } from "../src/gateway/tui.js";
import { modalFits } from "../src/gateway/tui-view.js";
import type { TuiModel } from "../src/gateway/tui-model.js";
import {
  FIXED_TUI_NOW,
  tuiDesignFixture,
  tuiDesignScenes,
  type TuiDesignScene,
} from "./helpers/tui-design-fixtures.js";

const sgr = /\u001b\[[0-9;]*m/u;
const allSgr = /\u001b\[[0-9;]*m/gu;
const capture = path.join(process.cwd(), "test/helpers/tui-capture.tsx");

function childCapture(scene: TuiDesignScene, noColor = false): string {
  const env: NodeJS.ProcessEnv = { ...process.env, FORCE_COLOR: "1" };
  if (noColor) env.NO_COLOR = "1";
  else delete env.NO_COLOR;
  const result = spawnSync(process.execPath, ["--import", "tsx", capture, scene, "140", "45"], {
    cwd: process.cwd(),
    env,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function childCaptureWithSelection(selected: number): string {
  const view = pathToFileURL(path.join(process.cwd(), "src/gateway/tui-view.tsx")).href;
  const fixtures = pathToFileURL(path.join(process.cwd(), "test/helpers/tui-design-fixtures.ts")).href;
  const script = `
    import { createElement } from "react";
    import { renderToString } from "ink";
    import { TuiView } from ${JSON.stringify(view)};
    import { FIXED_TUI_NOW, tuiDesignFixture } from ${JSON.stringify(fixtures)};
    const model = tuiDesignFixture("endpoints"); model.selected.endpoints = ${selected};
    Date.now = () => FIXED_TUI_NOW;
    process.stdout.write(renderToString(createElement(TuiView, { model, columns: 140, rows: 45, now: FIXED_TUI_NOW, color: true }), { columns: 140 }));
  `;
  const env: NodeJS.ProcessEnv = { ...process.env, FORCE_COLOR: "1" };
  delete env.NO_COLOR;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
    cwd: process.cwd(), env, encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

test("every design scene stays inside its terminal cell bounds at the acceptance sizes", () => {
  for (const scene of tuiDesignScenes) {
    for (const [columns, rows] of [[80, 24], [100, 30], [140, 45]] as const) {
      const output = renderTui(tuiDesignFixture(scene), columns, rows, FIXED_TUI_NOW, false);
      const lines = output.split("\n");
      assert.ok(lines.length <= rows, `${scene} rendered ${lines.length} rows into ${rows}`);
      for (const [index, line] of lines.entries())
        assert.ok(stringWidth(line) <= columns, `${scene} row ${index + 1} rendered ${stringWidth(line)} cells into ${columns}`);
    }
  }
});

test("endpoint groups preserve state order, counts, collisions, and the 80-column footer", () => {
  const output = renderTui(tuiDesignFixture("endpoints"), 140, 45, FIXED_TUI_NOW, false);
  const headings = ["Working (1)", "Waiting (1)", "Faulted (1)", "Ready (2)", "Dormant (1)", "Not reporting (1)", "Cached (2)"];
  let prior = -1;
  for (const heading of headings) {
    const position = output.indexOf(heading);
    assert.ok(position > prior, `${heading} must follow the preceding group`);
    prior = position;
  }
  assert.equal(output.match(/ambiguous name · endpoint …0000000[34]/gu)?.length, 2);
  assert.match(output, /codex-資料-e\u0301quipe/);
  const narrow = renderTui(tuiDesignFixture("endpoints"), 80, 24, FIXED_TUI_NOW, false);
  assert.match(narrow, /q:quit/);
  assert.ok(narrow.split("\n").every((line) => stringWidth(line) <= 80));
});

test("Ink assigns the basic semantic palette and NO_COLOR suppresses every SGR", () => {
  const styled = childCapture("endpoints");
  const unselectedStates = childCaptureWithSelection(3);
  assert.match(styled, /\u001b\[7m> busy/);
  assert.match(unselectedStates, /\u001b\[33mbusy\s+\u001b\[39m/);
  assert.match(unselectedStates, /\u001b\[35mwaiting\s+\u001b\[39m/);
  assert.match(unselectedStates, /\u001b\[32midle\s+\u001b\[39m/);
  assert.match(unselectedStates, /\u001b\[31msystemError\s+\u001b\[39m/);
  const plain = childCapture("endpoints", true);
  assert.doesNotMatch(plain, sgr);
  assert.match(plain, /busy[\s\S]*waiting[\s\S]*systemError[\s\S]*idle/);
});

test("retirement confirmation shows exact identity and consequences if and only if it fits", () => {
  const model = tuiDesignFixture("retirement-confirm");
  for (const [columns, rows] of [[100, 30], [80, 24], [47, 45], [80, 10]] as const) {
    const fits = modalFits(model, columns, rows);
    const output = renderTui(model, columns, rows, FIXED_TUI_NOW, false);
    assert.equal(output.includes("reg_busy_000000000000000000000001"), fits);
    assert.equal(output.includes("queued/reserved work is cancelled"), fits);
    assert.equal(output.includes("terminal too small"), !fits);
  }

  const oversized = structuredClone(model);
  assert.ok(oversized.retiring);
  oversized.retiring = { ...oversized.retiring, id: `reg_${"x".repeat(600)}` };
  assert.equal(modalFits(oversized, 80, 24), false);
  const refused = renderTui(oversized, 80, 24, FIXED_TUI_NOW, false);
  assert.match(refused, /terminal too small[\s\S]*Resize to show the exact endpoint ID and consequences/);
  assert.doesNotMatch(refused, /reg_x/);
});

test("honesty and action guidance remain present across connection states", () => {
  const stale = renderTui(tuiDesignFixture("stale-unreachable"), 100, 30, FIXED_TUI_NOW, false);
  assert.match(stale, /broker UNREACHABLE/);
  assert.match(stale, /STALE 45s !PEER_TUNNEL_UNAVAILABLE/);
  assert.match(stale, /Run embassy service status on this-mac/);
  assert.match(stale, /not a provider readiness proof/);

  const first = renderTui(tuiDesignFixture("first-connection"), 80, 24, FIXED_TUI_NOW, false);
  assert.match(first, /broker not reachable/);
  assert.match(first, /Updated never[\s\S]*not a provider readiness proof/);

  const action = tuiDesignFixture("endpoints");
  action.action = "refresh in progress";
  action.actionRunning = true;
  const running = renderTui(action, 100, 30, FIXED_TUI_NOW, false);
  assert.match(running, /refresh in progress — polling paused/);
});

test("untrusted model text cannot inject terminal controls or raw escape bytes", () => {
  const model = structuredClone(tuiDesignFixture("endpoints")) as TuiModel;
  assert.ok(model.snapshot && Array.isArray(model.snapshot.routes));
  const route = model.snapshot.routes[0] as Record<string, unknown>;
  route.alias = "codex-safe\u001b]52;c;stolen\u0007\u001b[31m@m5dev";
  model.action = "refresh\u001b[2J\u001b[Hspoofed";
  const output = renderTui(model, 140, 45, FIXED_TUI_NOW, false);
  assert.doesNotMatch(output, /\u001b|\u0007/u);
  assert.doesNotMatch(output, /stolen|31m|2J|\[H/);
  assert.match(output, /codex-safe@m5dev/);
  assert.match(output, /refreshspoofed/);
});

test("endpoint layout protects outcome codes from long aliases at standard widths", () => {
  for (const columns of [100, 140]) {
    const output = renderTui(tuiDesignFixture("endpoints"), columns, 45, FIXED_TUI_NOW, false);
    assert.match(output, /REQUEST_TIMEOUT/, `failure code must remain visible at ${columns} columns`);
    assert.doesNotMatch(output, /codex-資料-e\u0301quipe-with-an-intentionally-long-name@m5dev/,
      `the alias column must yield space to the outcome at ${columns} columns`);
    assert.ok(output.split("\n").every((line) => stringWidth(line) <= columns));
  }
});

test("selection caret starts delivery, retirement and result rows at terminal column zero", () => {
  const delivery = renderTui(tuiDesignFixture("deliveries"), 100, 30, FIXED_TUI_NOW, false);
  assert.match(delivery, /^> .*delivered/m);
  const retirement = renderTui(tuiDesignFixture("retirements"), 100, 30, FIXED_TUI_NOW, false);
  assert.match(retirement, /^> .*codex-old-release@m5dev/m);
  const result = renderTui(tuiDesignFixture("result"), 100, 30, FIXED_TUI_NOW, false);
  assert.match(result, /^> delivery /m);
});

test("unknown provider state is dim beneath the Not reporting group", () => {
  const styled = childCapture("endpoints");
  assert.match(styled.replace(allSgr, ""), /Not reporting \(1\)[\s\S]*\bunknown\b/);
  assert.match(styled, /\u001b\[2munknown\s+\u001b\[22m/);
});

test("empty sections explain what is absent rather than showing a generic empty row", () => {
  const model = tuiDesignFixture("empty");
  const expected = {
    endpoints: "No endpoints registered.",
    deliveries: "No deliveries yet.",
    retirements: "No retirements.",
  } as const;
  for (const section of ["endpoints", "deliveries", "retirements"] as const) {
    model.section = section;
    const output = renderTui(model, 100, 30, FIXED_TUI_NOW, false);
    assert.match(output, new RegExp(expected[section].replace(".", "\\.")), `${section} needs a section-specific empty reason`);
    assert.doesNotMatch(output, /No rows\./);
  }

  const first = renderTui(tuiDesignFixture("first-connection"), 100, 30, FIXED_TUI_NOW, false);
  assert.match(first, /Broker not reachable\./);
  const unavailable = tuiDesignFixture("first-connection");
  unavailable.error = "CONTROL_UNAVAILABLE";
  unavailable.staleSince = FIXED_TUI_NOW - 2_000;
  assert.match(renderTui(unavailable, 100, 30, FIXED_TUI_NOW, false), /Broker unreachable \(!CONTROL_UNAVAILABLE\)\./);
});

test("rendered-line pagination has both edge markers and never strands a group header", () => {
  const model = tuiDesignFixture("empty");
  assert.ok(model.snapshot);
  model.snapshot.routes = Array.from({ length: 24 }, (_, index) => ({
    id: `reg_pagination_${String(index).padStart(3, "0")}`,
    alias: `codex-pagination-collision@m5dev`,
    host: "m5dev",
    provider: "codex",
    queueDepth: index,
    codex: { state: index < 8 ? "busy" : index < 16 ? "waiting" : "idle" },
    lastOperation: { outcome: index % 2 ? "failed" : "delivered", code: index % 2 ? "REQUEST_TIMEOUT" : "DELIVERED" },
  }));
  model.selected.endpoints = 12;
  const output = renderTui(model, 80, 24, FIXED_TUI_NOW, false);
  const above = /^\s*↑ (\d+) more/m.exec(output);
  const below = /^\s*↓ (\d+) more/m.exec(output);
  assert.ok(above);
  assert.ok(below);
  const visibleRows = output.split("\n").filter((line) => /^(?:> |  )(?:busy|waiting|idle)\b/.test(line)).length;
  assert.equal(Number(above[1] ?? -1) + visibleRows + Number(below[1] ?? -1), 24,
    "edge counts describe hidden selectable rows, not headers or continuation lines");
  assert.doesNotMatch(output, /(?:Working|Waiting|Faulted|Ready|Dormant|Not reporting|Cached) \(\d+\)\n\s*[↑↓]/);
  const lines = output.split("\n");
  for (const [index, line] of lines.entries()) if (/^(?:Working|Waiting|Faulted|Ready|Dormant|Not reporting|Cached) \(\d+\)$/.test(line))
    assert.match(lines[index + 1] ?? "", /codex-pagin/, `orphaned group header at rendered line ${index + 1}`);
  assert.match(output, /codex-pagin/);
});

function inverseText(line: string): string {
  let inverse = false, result = "", index = 0;
  while (index < line.length) {
    const match = /^\u001b\[([0-9;]*)m/u.exec(line.slice(index));
    if (match) {
      for (const raw of (match[1] ?? "").split(";")) {
        const code = Number(raw || 0);
        if (code === 0 || code === 27) inverse = false;
        if (code === 7) inverse = true;
      }
      index += match[0].length;
    } else {
      const character = String.fromCodePoint(line.codePointAt(index)!);
      if (inverse) result += character;
      index += character.length;
    }
  }
  return result;
}

test("reverse video is one continuous selected row and never a host or alarm banner", () => {
  const endpoints = childCapture("endpoints");
  const selected = endpoints.split("\n").find((line) => line.replace(allSgr, "").startsWith("> busy"));
  assert.ok(selected);
  assert.equal(inverseText(selected), selected.replace(allSgr, ""), "the selected bar must not contain unstyled holes");

  const hosts = childCapture("multi-host-overview");
  const alarm = childCapture("stale-unreachable");
  const hostLine = hosts.split("\n").find((line) => line.replace(allSgr, "").includes("lab-node"));
  const alarmLines = alarm.split("\n").filter((line) => /UNREACHABLE|STALE|PEER_TUNNEL_UNAVAILABLE/.test(line.replace(allSgr, "")));
  assert.ok(hostLine);
  assert.equal(inverseText(hostLine), "", "host tabs must not compete with row selection");
  assert.ok(alarmLines.length > 0);
  for (const line of alarmLines) assert.equal(inverseText(line), "", "alarm lines use red text, not reverse video");
});

test("chrome counters and result scrolling remain explicit", () => {
  const endpoints = renderTui(tuiDesignFixture("endpoints"), 100, 30, FIXED_TUI_NOW, false);
  assert.match(endpoints, /^endpoints 1\/9 · \[\/\]:host Tab:view/m);

  const result = renderTui(tuiDesignFixture("result"), 100, 30, FIXED_TUI_NOW, false);
  assert.match(result, /^result line 1\/7 · /m);
  assert.match(result, /delivery dlv_abcdefghijklmnopqrstuvwx:/);
  const scrolledModel = tuiDesignFixture("result");
  scrolledModel.selected.result = 6;
  assert.match(renderTui(scrolledModel, 80, 24, FIXED_TUI_NOW, false), /^result line 7\/7 · /m);

  const wide = renderTui(tuiDesignFixture("endpoints"), 140, 45, FIXED_TUI_NOW, false);
  assert.match(wide, /Updated just now · Codex discovery up to 20 most recent · 2s ago/);
  assert.match(wide, /not a provider readiness proof/);
});
