import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, unlink, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { LOCAL_CONTROL_VERSION, LocalControlError, requestLocalControl, serveLocalControl } from "../src/gateway/local-control.js";

async function fixture(t: { after: (cleanup: () => Promise<void>) => void }) {
  const root = await mkdtemp(path.join(await realpath(os.tmpdir()), "lc-"));
  const stateDir = path.join(root, "s");
  const socketPath = path.join(stateDir, "c.sock");
  await mkdir(stateDir, { mode: 0o700 });
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, stateDir, socketPath };
}

async function raw(socketPath: string, body: string | Buffer): Promise<Record<string, unknown>> {
  return await new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let bytes = Buffer.alloc(0);
    socket.once("error", reject);
    socket.on("data", (chunk: Buffer) => {
      bytes = Buffer.concat([bytes, chunk]);
      const newline = bytes.indexOf(0x0a);
      if (newline < 0) return;
      socket.destroy();
      resolve(JSON.parse(bytes.subarray(0, newline).toString("utf8")) as Record<string, unknown>);
    });
    socket.once("connect", () => socket.end(body));
  });
}

async function listen(server: net.Server, socketPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject); server.listen(socketPath, resolve);
  });
}

async function close(server: net.Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
const wire = (input: unknown): string => `${JSON.stringify({ protocolVersion: LOCAL_CONTROL_VERSION, input })}\n`;
const failed = (code: string) => ({ protocolVersion: LOCAL_CONTROL_VERSION, ok: false, error: { code } });

test("generic control round-trips one strict JSON frame and never reflects handler failures", async (t) => {
  const f = await fixture(t);
  const secret = "private handler detail";
  const server = await serveLocalControl({ ...f, handle: async (input) => {
    if ((input as { fail?: boolean }).fail) throw new Error(secret);
    return { echoed: input };
  } });
  assert.equal((await lstat(f.socketPath)).mode & 0o777, 0o600);
  assert.deepEqual(await requestLocalControl({ ...f, request: { value: 1 }, mutating: false }),
    { echoed: { value: 1 } });
  await assert.rejects(requestLocalControl({ ...f, request: { fail: true }, mutating: true }),
    (error: unknown) => error instanceof LocalControlError && error.code === "CONTROL_WRITE_OUTCOME_AMBIGUOUS" &&
      error.ambiguous && !error.message.includes(secret));
  await server.close();
});

test("atomic handoff batches fit the control envelope and oversized requests never reach the handler", async (t) => {
  const f = await fixture(t);
  let calls = 0;
  const server = await serveLocalControl({ ...f, handle: async () => { calls++; return { accepted: true }; } });
  assert.deepEqual(await requestLocalControl({ ...f, request: { body: "x".repeat(40 * 1024) }, mutating: true }), { accepted: true });
  await assert.rejects(requestLocalControl({ ...f, request: { body: "x".repeat(256 * 1024) }, mutating: true }),
    (error: unknown) => error instanceof LocalControlError && error.code === "FRAME_TOO_LARGE" && !error.ambiguous);
  assert.equal(calls, 1);
  await server.close();
});

test("server rejects invalid UTF-8, multiple frames, oversized frames and silent readers with safe codes", async (t) => {
  const f = await fixture(t);
  const server = await serveLocalControl({ ...f, requestBytes: 256, handle: async (input) => input });
  for (const [body, code] of [
    [Buffer.from([0xff, 0x0a]), "INVALID_JSON"],
    [`${wire({})}${wire({})}`, "MULTIPLE_FRAMES"],
    [Buffer.alloc(257, 0x20), "FRAME_TOO_LARGE"],
  ] as const) {
    const response = await raw(f.socketPath, body);
    assert.deepEqual(response, failed(code));
  }
  const timeout = await new Promise<Record<string, unknown>>((resolve, reject) => {
    const socket = net.createConnection(f.socketPath);
    let bytes = Buffer.alloc(0);
    socket.once("error", reject);
    socket.on("data", (chunk: Buffer) => {
      bytes = Buffer.concat([bytes, chunk]);
      const newline = bytes.indexOf(0x0a);
      if (newline >= 0) { socket.destroy(); resolve(JSON.parse(bytes.subarray(0, newline).toString("utf8"))); }
    });
  });
  assert.deepEqual(timeout, failed("REQUEST_TIMEOUT"));
  await server.close();
});

test("server caps concurrent control readers at thirty-two", async (t) => {
  const f = await fixture(t);
  const server = await serveLocalControl({ ...f, handle: async (input) => input });
  const held = await Promise.all(Array.from({ length: 32 }, async () => await new Promise<net.Socket>(
    (resolve, reject) => {
      const socket = net.createConnection(f.socketPath);
      socket.once("connect", () => resolve(socket)); socket.once("error", reject);
    },
  )));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(await raw(f.socketPath, wire({})), failed("SERVER_BUSY"));
  for (const socket of held) socket.destroy();
  await server.close();
});

test("version 6 is checked before the semantic handler and reply skew preserves mutation ambiguity", async (t) => {
  assert.equal(LOCAL_CONTROL_VERSION, 6);
  const f = await fixture(t);
  let calls = 0;
  const served = await serveLocalControl({ ...f, handle: async () => { calls += 1; return {}; } });
  assert.deepEqual(await raw(f.socketPath, `${JSON.stringify({ protocolVersion: 5, input: {} })}\n`),
    failed("UNSUPPORTED_VERSION"));
  assert.equal(calls, 0);
  await served.close();

  const skewed = net.createServer((socket) => socket.once("data", () => socket.end(`${JSON.stringify({
    protocolVersion: 5, ok: true, result: {},
  })}\n`)));
  await listen(skewed, f.socketPath); await chmod(f.socketPath, 0o600);
  await assert.rejects(requestLocalControl({ ...f, request: {}, mutating: false }),
    (error: unknown) => error instanceof LocalControlError && error.code === "CONTROL_VERSION_MISMATCH" && !error.ambiguous);
  await assert.rejects(requestLocalControl({ ...f, request: {}, mutating: true }),
    (error: unknown) => error instanceof LocalControlError && error.code === "CONTROL_WRITE_OUTCOME_AMBIGUOUS" && error.ambiguous);
  await close(skewed);
});

test("server requires exact private paths, preserves unsafe targets and never unlinks a live socket", async (t) => {
  const f = await fixture(t);
  await chmod(f.stateDir, 0o755);
  await assert.rejects(serveLocalControl({ ...f, handle: async () => null }), { code: "INSECURE_STATE_DIR" });
  await chmod(f.stateDir, 0o700);
  await writeFile(f.socketPath, "keep", { mode: 0o600 });
  await assert.rejects(serveLocalControl({ ...f, handle: async () => null }), { code: "UNSAFE_SOCKET_TARGET" });
  assert.equal(await readFile(f.socketPath, "utf8"), "keep");
  await unlink(f.socketPath);
  const live = net.createServer();
  await listen(live, f.socketPath);
  await assert.rejects(serveLocalControl({ ...f, handle: async () => null }), { code: "SOCKET_IN_USE" });
  assert.equal((await lstat(f.socketPath)).isSocket(), true);
  await close(live);
});

test("close removes only its owned socket and restores a path replacement byte-for-byte", async (t) => {
  const f = await fixture(t);
  const server = await serveLocalControl({ ...f, handle: async () => null });
  await unlink(f.socketPath);
  await writeFile(f.socketPath, "replacement", { mode: 0o600 });
  await server.close();
  assert.equal(await readFile(f.socketPath, "utf8"), "replacement");
  await server.close();
});

test("client distinguishes pre-connect failures and makes every lost started mutation ambiguous", async (t) => {
  const f = await fixture(t);
  await assert.rejects(requestLocalControl({ ...f, request: {}, mutating: true }),
    (error: unknown) => error instanceof LocalControlError && error.code === "CONTROL_SOCKET_MISSING" && !error.ambiguous);

  const dropping = net.createServer((socket) => socket.once("data", () => socket.destroy()));
  await listen(dropping, f.socketPath);
  await chmod(f.socketPath, 0o600);
  await assert.rejects(requestLocalControl({ ...f, request: { mutate: true }, mutating: true }),
    (error: unknown) => error instanceof LocalControlError && error.code === "CONTROL_WRITE_OUTCOME_AMBIGUOUS" &&
      error.ambiguous && !error.recoverable);
  await close(dropping);

  const holder = net.createServer();
  await listen(holder, f.socketPath); await chmod(f.socketPath, 0o600);
  const deniedCreate = net.createConnection;
  try {
    net.createConnection = (() => {
      const socket = new net.Socket();
      queueMicrotask(() => socket.emit("error", Object.assign(new Error("private"), { code: "EPERM" })));
      return socket;
    }) as typeof net.createConnection;
    await assert.rejects(requestLocalControl({ ...f, request: {}, mutating: true }),
      (error: unknown) => error instanceof LocalControlError && error.code === "CONTROL_CONNECT_DENIED" && !error.ambiguous);
  } finally { net.createConnection = deniedCreate; await close(holder); }
});

test("malformed, oversized and missing responses preserve read-only codes but make mutations ambiguous", async (t) => {
  for (const [mode, expected] of [["malformed", "CONTROL_INVALID_RESPONSE"],
    ["oversized", "CONTROL_RESPONSE_TOO_LARGE"], ["closed", "CONTROL_CONNECTION_CLOSED"]] as const) {
    const f = await fixture(t);
    const server = net.createServer((socket) => socket.once("data", () => {
      if (mode === "malformed") socket.end("not-json\n");
      else if (mode === "oversized") socket.end(`${"x".repeat(256 * 1024 + 1)}\n`);
      else socket.destroy();
    }));
    await listen(server, f.socketPath); await chmod(f.socketPath, 0o600);
    await assert.rejects(requestLocalControl({ ...f, request: {}, mutating: false }),
      (error: unknown) => error instanceof LocalControlError && error.code === expected && !error.ambiguous);
    await assert.rejects(requestLocalControl({ ...f, request: {}, mutating: true }),
      (error: unknown) => error instanceof LocalControlError && error.code === "CONTROL_WRITE_OUTCOME_AMBIGUOUS" && error.ambiguous);
    await close(server);
  }
});
