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
  observedAt: "2026-09-06T00:00:00.000Z", safeErrorCode: "PROTOCOL_ERROR" }, routes: [
  route("reg_waiting", "waiting@local", { state: "waiting" }),
  route("reg_idle", "idle@local", { state: "idle" }),
  route("reg_unknown", "unknown@local", { state: "unknown" }),
  route("reg_busy", "busy@local", { state: "busy" }),
  route("reg_dormant", "dormant@local", { state: "dormant" }),
], messages: [], retirements: [] };
const sink = () => { let value = ""; return { stream: Object.assign(new Writable({ write(chunk, _encoding, done) { value += chunk; done(); } }), { isTTY: true }), read: () => value }; };

test("status renders root observation states in directory order without native identity", async (t) => {
  const root = await mkdtemp(path.join(await realpath(os.tmpdir()), "emb-codex-view-"));
  await chmod(root, 0o700); await writeFile(path.join(root, "nodes.json"), JSON.stringify({ version: 1, host: "local", nodes: [] }), { mode: 0o600 });
  const control = await serveLocalControl({ stateDir: root, socketPath: path.join(root, "control.sock"), handle: async () => ({ ok: true, result: snapshot }) });
  t.after(async () => { await control.close(); await rm(root, { recursive: true, force: true }); });
  const output = sink(); assert.equal(await runCoreCli(["status"], { env: { EMBASSY_STATE_DIR: root }, stdout: output.stream }), 0);
  const rendered = output.read();
  assert.match(rendered, /Codex discovery: partial \/ truncated \/ PROTOCOL_ERROR \(\d+ ms ago\)/);
  assert.ok(rendered.indexOf("waiting@local") < rendered.indexOf("idle@local"));
  for (const state of ["waiting", "idle", "busy", "dormant", "unknown"]) assert.match(rendered, new RegExp(`${state}@local.*${state}`));
  assert.doesNotMatch(rendered, /native|thread[_-]?id|reg_absent/iu);
});

test("TUI shows root states without changing endpoint selection", () => {
  const model: TuiModel = { snapshot, snapshotAt: Date.parse("2026-09-06T00:00:00.000Z"), host: "local", section: "endpoints",
    selected: { endpoints: 0, deliveries: 0, retirements: 0 }, selectedEndpoint: "local\0reg_waiting", mode: "browse", token: "" };
  const rendered = renderTui(model, 160, 28, Date.parse("2026-09-06T00:00:30.000Z"));
  assert.match(rendered, /Codex discovery partial · truncated · 30s ago !PROTOCOL_ERROR/);
  assert.ok(rendered.indexOf("waiting@local") < rendered.indexOf("idle@local"));
  assert.match(rendered, /> waiting\s+waiting@local/);
  assert.match(rendered, /unknown\s+unknown@local/);
  assert.doesNotMatch(rendered, /native|thread[_-]?id|reg_absent/iu);
  const complete = renderTui({ ...model, snapshot: { ...snapshot,
    codex: { ...snapshot.codex, complete: true, truncated: false } } }, 160, 28);
  assert.match(complete, /Codex discovery up to 20 most recent/);
});
