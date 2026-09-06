import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
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
  const headings = ["Working (1)", "Waiting (1)", "Ready (2)", "Dormant (1)", "Unobserved (1)", "Faulted (1)", "Cached (2)"];
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
  assert.match(styled, /\u001b\[7m> \u001b\[33mbusy\u001b\[39m\u001b\[27m/);
  assert.match(styled, /\u001b\[35mwaiting\u001b\[39m/);
  assert.match(styled, /\u001b\[32midle\u001b\[39m/);
  assert.match(styled, /\u001b\[31msystemError\u001b\[39m/);
  const plain = childCapture("endpoints", true);
  assert.doesNotMatch(plain, sgr);
  assert.match(plain, /busy[\s\S]*waiting[\s\S]*idle[\s\S]*systemError/);
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
  assert.match(first, /Updated never · not a provider readiness proof/);

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
