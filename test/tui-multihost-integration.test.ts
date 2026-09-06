import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { isBrokerResult, type BrokerCommand } from "../src/gateway/broker-control.js";
import { requestLocalControl } from "../src/gateway/local-control.js";
import { runCoreRuntime, type CoreRuntimeDependencies } from "../src/gateway/runtime.js";
import { runTui } from "../src/gateway/tui.js";
import { createTuiSshClient } from "../src/gateway/tui-ssh.js";

test("one terminal reads two real test-owned brokers and retires only the confirmed remote endpoint via the real CLI", async (t) => {
  const root = await mkdtemp(path.join(await realpath(os.tmpdir()), "emb-mht-"));
  const runs: Promise<void>[] = [], stops: AbortController[] = [];
  let nativeWrites = 0;
  const state = (host: string) => path.join(root, host);
  const call = async (host: string, request: BrokerCommand) => {
    const response = await requestLocalControl({ stateDir: state(host), socketPath: path.join(state(host), "control.sock"), request,
      mutating: request.method !== "list_snapshot" }) as { ok: boolean; result: unknown };
    assert.equal(response.ok, true); assert.equal(isBrokerResult(request.method, response.result), true);
    return response.result;
  };
  t.after(async () => { for (const stop of stops) stop.abort(); await Promise.all(runs); await rm(root, { recursive: true, force: true }); });
  for (const host of ["local", "remote"]) {
    await mkdir(state(host), { mode: 0o700 }); await chmod(state(host), 0o700);
    await writeFile(path.join(state(host), "nodes.json"), JSON.stringify({ version: 1, host, nodes: [] }), { mode: 0o600 });
    const dependencies: CoreRuntimeDependencies = {
      createCodexDiscovery: () => undefined,
      loginHome: () => state(host),
      acquireLease: async () => ({ lost: new Promise<void>(() => {}), isLost: () => false, close: async () => {} }),
      attestClaudeRuntime: async () => ({ sessionsDir: path.join(root, "sessions"), socketDir: path.join(root, "sockets") }),
      createClaudePeer: () => ({ discover: async () => ({ peers: [], rejected: {}, truncated: false, entriesScanned: 0, parseableRecords: 0 }),
        resolveReplyAddress: async () => { throw new Error("no Claude"); }, assertTargetWorkspaceDisjoint: async () => {},
        prepareSend: async () => { nativeWrites++; throw new Error("no native writes"); }, close: async () => {} }),
      createCodexOperation: () => ({ execute: async () => { nativeWrites++; throw new Error("no native writes"); } }),
    };
    const stop = new AbortController(); stops.push(stop);
    let ready!: () => void; const started = new Promise<void>((resolve) => { ready = resolve; });
    runs.push(runCoreRuntime({ env: { EMBASSY_STATE_DIR: state(host) }, signal: stop.signal, onReady: ready }, dependencies));
    await started;
    await call(host, { method: "register_codex", params: { alias: `codex-worker@${host}`,
      caller: { kind: "codex", handle: "00000000-0000-4000-8000-000000000001" } } });
  }
  const cli = fileURLToPath(new URL("../dist/src/gateway/core-cli.js", import.meta.url));
  const commands: string[][] = [];
  const ssh = createTuiSshClient({ nodes: ["remote"], spawn: (command, args, options) => {
    assert.equal(command, "/usr/bin/ssh");
    const offset = args.indexOf("remote"); assert.ok(offset >= 0); assert.equal(args[offset + 1], "embassy");
    const cliArgs = [...args.slice(offset + 2)]; commands.push(cliArgs);
    // Only the SSH process is replaced: the remote command is the real packaged CLI.
    return spawn(process.execPath, [cli, ...cliArgs], { ...options, env: { EMBASSY_STATE_DIR: state("remote") } });
  } });
  const keys = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {} });
  let bytes = "";
  const output = Object.assign(new Writable({ write(chunk, _enc, done) { bytes += String(chunk); done(); } }), { isTTY: true, columns: 120, rows: 30 });
  const stop = new AbortController();
  const tui = runTui({ input: keys, output, host: "local", call: (request) => call("local", request), renderStatus: () => "plain",
    terminal: { noColor: true, dumb: false },
    signal: stop.signal, remote: { hosts: ["remote"], call: ssh.call, close: ssh.close } });
  t.after(async () => { stop.abort(); await tui; });
  const waitFor = async (pattern: RegExp) => {
    const deadline = Date.now() + 5_000;
    while (!pattern.test(bytes) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.match(bytes, pattern);
  };
  await waitFor(/remote.*healthy/); assert.match(bytes, /local.*healthy/);
  keys.write("]x"); await waitFor(/Host: remote/); await waitFor(/Endpoint ID[\s\S]*reg_/);
  keys.write("y"); await waitFor(/retire result ready/);
  const local = await call("local", { method: "list_snapshot", params: {} }) as { routes: unknown[] };
  const remote = await call("remote", { method: "list_snapshot", params: {} }) as { routes: unknown[] };
  assert.equal(local.routes.length, 1); assert.equal(remote.routes.length, 0); assert.equal(nativeWrites, 0);
  assert.equal(commands.filter(([verb]) => verb === "retire").length, 1);
  assert.match(commands.find(([verb]) => verb === "retire")?.[2] ?? "", /^reg_/);
  keys.write("q"); await tui;
});
