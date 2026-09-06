import assert from "node:assert/strict";
import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import test from "node:test";
import { runCoreCli } from "../src/gateway/core-cli.js";
import { serveLocalControl } from "../src/gateway/local-control.js";
import { renderTui, type TuiModel } from "../src/gateway/tui.js";

const route = (id: string, alias: string, codex: Record<string, unknown>) =>
  ({ id, alias, host: "local", provider: "codex", queueDepth: 0, codex });
const snapshot = { health: "healthy", revision: 1, codex: { complete: false, truncated: true,
  observedAt: "2026-09-06T00:00:00.000Z", safeErrorCode: "CODEX_DISCOVERY_UNAVAILABLE" }, routes: [
  route("reg_child", "child@local", { state: "waitingOnApproval", canAcceptDirectInput: false, parentEndpoint: "reg_parent" }),
  route("reg_parent", "parent@local", { state: "idle", canAcceptDirectInput: true }),
  route("reg_missing", "orphan@local", { state: "unknown", canAcceptDirectInput: "unknown", parentEndpoint: "reg_absent" }),
  route("reg_cycle_a", "cycle-a@local", { state: "active", canAcceptDirectInput: true, parentEndpoint: "reg_cycle_b" }),
  route("reg_cycle_b", "cycle-b@local", { state: "active", canAcceptDirectInput: true, parentEndpoint: "reg_cycle_a" }),
], messages: [], retirements: [] };
const sink = () => { let value = ""; return { stream: Object.assign(new Writable({ write(chunk, _encoding, done) { value += chunk; done(); } }), { isTTY: true }), read: () => value }; };

test("status renders bounded Codex observation and parent grouping without native identity", async (t) => {
  const root = await mkdtemp(path.join(await realpath(os.tmpdir()), "emb-codex-view-"));
  await chmod(root, 0o700); await writeFile(path.join(root, "nodes.json"), JSON.stringify({ version: 1, host: "local", nodes: [] }), { mode: 0o600 });
  const control = await serveLocalControl({ stateDir: root, socketPath: path.join(root, "control.sock"), handle: async () => ({ ok: true, result: snapshot }) });
  t.after(async () => { await control.close(); await rm(root, { recursive: true, force: true }); });
  const output = sink(); assert.equal(await runCoreCli(["status"], { env: { EMBASSY_STATE_DIR: root }, stdout: output.stream }), 0);
  const rendered = output.read();
  assert.match(rendered, /Codex discovery: partial \/ truncated \/ CODEX_DISCOVERY_UNAVAILABLE \(\d+ ms ago\)/);
  assert.ok(rendered.indexOf("parent@local") < rendered.indexOf("↳ child@local"));
  assert.match(rendered, /child@local.*waitingOnApproval \/ direct input refused/);
  assert.match(rendered, /^orphan@local/m); assert.match(rendered, /^cycle-[ab]@local/m);
  assert.doesNotMatch(rendered, /native|thread[_-]?id|reg_absent/iu);
});

test("TUI shows Codex observation, readiness, and safe hierarchy without changing endpoint selection", () => {
  const model: TuiModel = { snapshot, snapshotAt: Date.parse("2026-09-06T00:00:00.000Z"), host: "local", section: "endpoints",
    selected: { endpoints: 0, deliveries: 0, retirements: 0 }, selectedEndpoint: "local\0reg_child", mode: "browse", token: "" };
  const rendered = renderTui(model, 160, 28, Date.parse("2026-09-06T00:00:30.000Z"));
  assert.match(rendered, /Codex discovery partial · truncated · 30s ago !CODEX_DISCOVERY_UNAVAILABLE/);
  assert.ok(rendered.indexOf("parent@local") < rendered.indexOf("↳ child@local"));
  assert.match(rendered, /> ↳ child@local.*waitingOnApproval · direct input refused/);
  assert.match(rendered, /orphan@local.*unknown · direct input unknown/);
  assert.doesNotMatch(rendered, /native|thread[_-]?id|reg_absent/iu);
});
