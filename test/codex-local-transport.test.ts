import assert from "node:assert/strict";
import type { SpawnOptionsWithoutStdio } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter, once } from "node:events";
import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer, type Server } from "node:net";
import path from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import type { CodexAppServerTransport } from "../src/gateway/codex-app-server.js";
import {
  buildLocalCodexProxyEnvironment,
  createLocalCodexTransportFactory,
  LocalCodexTransportError,
  resolveManagedLocalCodexInstallation,
  terminateOwnedLocalProxy,
  validateLocalCodexHome,
} from "../src/gateway/codex-local-transport.js";

const VERSION = "0.147.0";

type InstallationFixture = {
  binary: string;
  close: () => Promise<void>;
  home: string;
  root: string;
  socket: string;
};

async function installationFixture(
  releaseLeaf = VERSION,
): Promise<InstallationFixture> {
  // Keep the synthetic Unix-domain socket below macOS's short sun_path cap.
  const root = await mkdtemp(path.join("/tmp", "clt-"));
  const home = path.join(root, "home");
  const standalone = path.join(home, ".codex", "packages", "standalone");
  const release = path.join(standalone, "releases", releaseLeaf);
  const binary = path.join(release, "codex");
  const control = path.join(home, ".codex", "app-server-control");
  const socket = path.join(control, "app-server-control.sock");
  await mkdir(release, { recursive: true, mode: 0o700 });
  await writeFile(binary, "synthetic binary; never executed\n", { mode: 0o700 });
  await chmod(binary, 0o700);
  await symlink(path.join("releases", releaseLeaf), path.join(standalone, "current"));
  await mkdir(control, { recursive: true, mode: 0o700 });
  await chmod(control, 0o700);
  const server = createServer();
  server.listen(socket);
  await once(server, "listening");
  await chmod(socket, 0o600);
  return {
    binary,
    home,
    root,
    socket,
    close: async () => {
      await new Promise<void>((resolve) => (server as Server).close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    },
  };
}

class FakeChild extends EventEmitter {
  exitCode: number | null = null;
  readonly pid = 424_242;
  signalCode: NodeJS.Signals | null = null;
  readonly stderr = new PassThrough();
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();

  kill(signal?: NodeJS.Signals | number): boolean {
    this.signalCode = typeof signal === "string" ? signal : "SIGKILL";
    this.exitCode = 0;
    queueMicrotask(() => this.emit("close"));
    return true;
  }
}

class FakeTransport implements CodexAppServerTransport {
  closed = false;
  readonly sent: string[] = [];

  async send(payload: string): Promise<void> {
    this.sent.push(payload);
  }

  onMessage(): () => void {
    return () => undefined;
  }

  onClose(): () => void {
    return () => undefined;
  }

  onError(): () => void {
    return () => undefined;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

function attachSyntheticWebSocketPeer(child: FakeChild): Promise<string> {
  let received = Buffer.alloc(0);
  let upgraded = false;
  return new Promise<string>((resolve, reject) => {
    child.stdin.on("error", reject);
    child.stdin.on("data", (chunk: Buffer) => {
      received = Buffer.concat([received, chunk]);
      if (!upgraded) {
        const headerEnd = received.indexOf("\r\n\r\n");
        if (headerEnd === -1) return;
        const request = received.subarray(0, headerEnd + 4).toString("ascii");
        const key = /^Sec-WebSocket-Key:\s*([^\r\n]+)$/im.exec(request)?.[1];
        if (key === undefined) {
          reject(new Error("synthetic WebSocket key missing"));
          return;
        }
        const accept = createHash("sha1")
          .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
          .digest("base64");
        received = received.subarray(headerEnd + 4);
        upgraded = true;
        child.stdout.write(
          Buffer.from(
            "HTTP/1.1 101 Switching Protocols\r\n" +
              "Upgrade: websocket\r\n" +
              "Connection: Upgrade\r\n" +
              `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
            "ascii",
          ),
        );
      }

      while (upgraded && received.length >= 2) {
        const opcode = received[0]! & 0x0f;
        const masked = (received[1]! & 0x80) !== 0;
        let payloadLength = received[1]! & 0x7f;
        let offset = 2;
        if (payloadLength === 126) {
          if (received.length < 4) return;
          payloadLength = received.readUInt16BE(2);
          offset = 4;
        } else if (payloadLength === 127) {
          reject(new Error("synthetic WebSocket frame is unexpectedly large"));
          return;
        }
        if (!masked) {
          reject(new Error("synthetic WebSocket client frame is unmasked"));
          return;
        }
        const frameLength = offset + 4 + payloadLength;
        if (received.length < frameLength) return;
        const mask = received.subarray(offset, offset + 4);
        const payload = Buffer.from(
          received.subarray(offset + 4, frameLength),
        );
        for (let index = 0; index < payload.length; index += 1) {
          payload[index] = payload[index]! ^ mask[index % 4]!;
        }
        received = received.subarray(frameLength);
        if (opcode === 0x1) {
          resolve(payload.toString("utf8"));
          continue;
        }
        if (opcode === 0x8) {
          child.stdout.write(Buffer.from([0x88, 0x00]));
        }
      }
    });
  });
}

function syntheticKill(child: FakeChild): {
  killProcess: (pid: number, signal?: NodeJS.Signals | number) => true;
  signals: Array<NodeJS.Signals | number | undefined>;
} {
  let groupAlive = true;
  const signals: Array<NodeJS.Signals | number | undefined> = [];
  return {
    signals,
    killProcess: (pid, signal) => {
      assert.equal(pid, -child.pid);
      if (signal === 0) {
        if (!groupAlive) {
          throw Object.assign(new Error("gone"), { code: "ESRCH" });
        }
        return true;
      }
      signals.push(signal);
      groupAlive = false;
      child.signalCode = typeof signal === "string" ? signal : "SIGKILL";
      child.exitCode = 0;
      queueMicrotask(() => child.emit("close"));
      return true;
    },
  };
}

test("HOME and proxy environment are exact non-credential allowlists", () => {
  assert.equal(
    validateLocalCodexHome("/Users/tester", "/Users/tester"),
    "/Users/tester",
  );
  assert.throws(
    () => validateLocalCodexHome("/tmp/selected", "/Users/tester"),
    (error: unknown) =>
      error instanceof LocalCodexTransportError && error.code === "HOME_INVALID",
  );
  const environment = buildLocalCodexProxyEnvironment("/Users/tester", {
    HOME: "/Users/tester",
    USER: "tester",
    LOGNAME: "tester",
    CODEX_THREAD_ID: "private-task",
    ANTHROPIC_API_KEY: "secret",
    OPENAI_API_KEY: "secret",
    SSH_AUTH_SOCK: "/private/agent.sock",
    PATH: "/untrusted/bin",
  });
  assert.deepEqual(environment, {
    CODEX_HOME: "/Users/tester/.codex",
    HOME: "/Users/tester",
    LC_ALL: "C",
    LOGNAME: "tester",
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    USER: "tester",
  });
});

test("managed installation pins release binary and already-running private socket", async () => {
  const fixture = await installationFixture();
  try {
    const first = await resolveManagedLocalCodexInstallation(fixture.home);
    const second = await resolveManagedLocalCodexInstallation(fixture.home);
    assert.equal(first.binaryPath, await realpath(fixture.binary));
    assert.equal(first.controlSocketPath, fixture.socket);
    assert.match(first.endpointGeneration, /^local_[0-9a-f]{32}$/);
    assert.equal(first.endpointGeneration, second.endpointGeneration);
    await chmod(fixture.binary, 0o500);
    await chmod(fixture.binary, 0o700);
    const metadataChanged = await resolveManagedLocalCodexInstallation(
      fixture.home,
    );
    assert.notEqual(metadataChanged.endpointGeneration, first.endpointGeneration);
    const attested = await createLocalCodexTransportFactory(
      {
        environment: { HOME: fixture.home },
      },
      { loginHome: () => fixture.home },
    );
    assert.equal(attested.appServerVersion, VERSION);
    assert.equal(attested.protocolVersion, VERSION);
    await attested.close();
  } finally {
    await fixture.close();
  }
});

test("startup attests version-drifted Codex installations without opening App Server", async () => {
  for (const evidence of [
    { release: "0.148.0", observedVersion: "0.148.0" },
    { release: "1.0.0", observedVersion: "1.0.0" },
    { release: "nightly-2026", observedVersion: "unknown" },
  ] as const) {
    const installation = await installationFixture(evidence.release);
    try {
      let spawnCalls = 0;
      const factory = await createLocalCodexTransportFactory(
        {
          environment: { HOME: installation.home },
        },
        {
          loginHome: () => installation.home,
          spawn: () => {
            spawnCalls += 1;
            throw new Error("must not spawn during attestation");
          },
        },
      );

      assert.equal(factory.appServerVersion, evidence.observedVersion);
      assert.equal(factory.protocolVersion, evidence.observedVersion);
      assert.equal(spawnCalls, 0);
      await factory.close();
    } finally {
      await installation.close();
    }
  }
});

test("per-operation factory resolution attests the exact current managed release", async () => {
  const drifted = await installationFixture("0.148.0");
  try {
    let spawnCalls = 0;
    const candidate = await createLocalCodexTransportFactory(
      {
        environment: { HOME: drifted.home },
      },
      {
        loginHome: () => drifted.home,
        spawn: () => {
          spawnCalls += 1;
          throw new Error("factory resolution must not connect by itself");
        },
      },
    );
    assert.equal(candidate.appServerVersion, "0.148.0");
    assert.equal(candidate.protocolVersion, "0.148.0");
    assert.equal(spawnCalls, 0);
    await candidate.close();
  } finally {
    await drifted.close();
  }
});

test("bounded prerelease builds remain OS-attested without connecting", async () => {
  const drifted = await installationFixture("0.148.0-alpha.1");
  try {
    let spawnCalls = 0;
    const candidate = await createLocalCodexTransportFactory(
      {
        environment: { HOME: drifted.home },
      },
      {
        loginHome: () => drifted.home,
        spawn: () => {
          spawnCalls += 1;
          throw new Error("prerelease resolution must not connect");
        },
      },
    );
    assert.equal(candidate.appServerVersion, "0.148.0-alpha.1");
    assert.equal(candidate.protocolVersion, "0.148.0-alpha.1");
    assert.equal(spawnCalls, 0);
    await candidate.close();
  } finally {
    await drifted.close();
  }
});

test("unsafe release leaves remain rejected before provider construction", async () => {
  const drifted = await installationFixture("nightly build");
  try {
    await assert.rejects(
      createLocalCodexTransportFactory(
        {
          environment: { HOME: drifted.home },
        },
        { loginHome: () => drifted.home },
      ),
      (error: unknown) =>
        error instanceof LocalCodexTransportError &&
        error.code === "MANAGED_CODEX_INVALID",
    );
  } finally {
    await drifted.close();
  }
});

test("managed target-suffixed releases require the exact runtime architecture", async () => {
  const matching = await installationFixture(
    `${VERSION}-aarch64-apple-darwin`,
  );
  try {
    const installation = await resolveManagedLocalCodexInstallation(
      matching.home,
      { platform: "darwin", architecture: "arm64" },
    );
    assert.equal(installation.binaryPath, await realpath(matching.binary));
    await assert.rejects(
      resolveManagedLocalCodexInstallation(matching.home, {
        platform: "darwin",
        architecture: "x64",
      }),
      (error: unknown) =>
        error instanceof LocalCodexTransportError &&
        error.code === "MANAGED_CODEX_INVALID",
    );
  } finally {
    await matching.close();
  }

  const smuggled = await installationFixture(
    `${VERSION}-aarch64-apple-darwin-extra`,
  );
  try {
    await assert.rejects(
      resolveManagedLocalCodexInstallation(smuggled.home, {
        platform: "darwin",
        architecture: "arm64",
      }),
      (error: unknown) =>
        error instanceof LocalCodexTransportError &&
        error.code === "MANAGED_CODEX_INVALID",
    );
  } finally {
    await smuggled.close();
  }
});

test("managed release directory remains an owned non-writable component", async () => {
  const fixture = await installationFixture();
  try {
    await chmod(path.dirname(fixture.binary), 0o777);
    await assert.rejects(
      resolveManagedLocalCodexInstallation(fixture.home),
      (error: unknown) =>
        error instanceof LocalCodexTransportError &&
        error.code === "MANAGED_CODEX_INVALID",
    );
  } finally {
    await fixture.close();
  }
});

test("missing App Server socket stays OS-attested and never bootstraps", async () => {
  const fixture = await installationFixture();
  try {
    const live = await resolveManagedLocalCodexInstallation(fixture.home);
    // Unlinking the synthetic endpoint makes discovery fail; the test never
    // invokes a CLI that could create or bootstrap a replacement.
    await rm(fixture.socket, { force: true });
    const unavailable = await resolveManagedLocalCodexInstallation(fixture.home);
    assert.equal(
      unavailable.availabilityFailure,
      "CODEX_CONTROL_SOCKET_UNAVAILABLE",
    );
    assert.notEqual(unavailable.endpointGeneration, live.endpointGeneration);

    let spawnCalls = 0;
    const factory = await createLocalCodexTransportFactory(
      {
        environment: { HOME: fixture.home },
      },
      {
        loginHome: () => fixture.home,
        spawn: () => {
          spawnCalls += 1;
          throw new Error("an unavailable control socket must not spawn");
        },
      },
    );
    assert.equal(
      factory.availabilityFailure,
      "CODEX_CONTROL_SOCKET_UNAVAILABLE",
    );
    assert.equal(spawnCalls, 0);
    await assert.rejects(
      factory.connectTransport(),
      (error: unknown) =>
        error instanceof LocalCodexTransportError &&
        error.code === "LOCAL_APP_SERVER_NOT_RUNNING",
    );
    assert.equal(spawnCalls, 0);
    await factory.close();
  } finally {
    await fixture.close();
  }
});

test("unsafe App Server socket and directory permissions remain fatal", async () => {
  const fixture = await installationFixture();
  try {
    await chmod(fixture.socket, 0o666);
    await assert.rejects(
      resolveManagedLocalCodexInstallation(fixture.home),
      (error: unknown) =>
        error instanceof LocalCodexTransportError &&
        error.code === "LOCAL_APP_SERVER_ENDPOINT_UNSAFE",
    );
    await chmod(fixture.socket, 0o600);
    await rm(fixture.socket, { force: true });
    await chmod(path.dirname(fixture.socket), 0o777);
    await assert.rejects(
      resolveManagedLocalCodexInstallation(fixture.home),
      (error: unknown) =>
        error instanceof LocalCodexTransportError &&
        error.code === "LOCAL_APP_SERVER_ENDPOINT_UNSAFE",
    );
  } finally {
    await fixture.close();
  }
});

test("factory spawns only resolved proxy with strict options and owns cleanup", async () => {
  const fixture = await installationFixture();
  const child = new FakeChild();
  const transport = new FakeTransport();
  const killed = syntheticKill(child);
  let spawned:
    | {
        args: readonly string[];
        command: string;
        options: SpawnOptionsWithoutStdio;
      }
    | undefined;
  try {
    const factory = await createLocalCodexTransportFactory(
      {
        environment: {
          HOME: fixture.home,
          USER: "tester",
          OPENAI_API_KEY: "must-not-forward",
          CODEX_THREAD_ID: "must-not-forward",
        },
        gracefulExitMs: 1,
        maxStderrBytes: 8,
        signalTimeoutMs: 10,
        spawnTimeoutMs: 100,
      },
      {
        connectWebSocket: async () => transport,
        killProcess: killed.killProcess,
        loginHome: () => fixture.home,
        sleep: async () => undefined,
        spawn: (command, args, options) => {
          spawned = { command, args, options };
          queueMicrotask(() => child.emit("spawn"));
          return child as never;
        },
      },
    );
    assert.equal(factory.protocol, "codex-app-server");
    const owned = await factory.connectTransport();
    assert.equal(spawned?.command, await realpath(fixture.binary));
    assert.deepEqual(spawned?.args, ["app-server", "proxy"]);
    assert.equal(spawned?.options.detached, true);
    assert.equal(spawned?.options.shell, false);
    assert.deepEqual(spawned?.options.stdio, ["pipe", "pipe", "pipe"]);
    assert.equal(spawned?.options.env?.["OPENAI_API_KEY"], undefined);
    assert.equal(spawned?.options.env?.["CODEX_THREAD_ID"], undefined);
    await owned.send("synthetic frame");
    assert.deepEqual(transport.sent, ["synthetic frame"]);
    child.stderr.write(Buffer.from("discarded diagnostic sentinel"));
    await owned.close();
    assert.equal(owned.cleanupConfirmed, true);
    assert.equal(transport.closed, true);
    assert.deepEqual(killed.signals, ["SIGTERM"]);
    await factory.close();
  } finally {
    await fixture.close();
  }
});

test("first post-upgrade frame writes through the child proxy Duplex", async () => {
  const fixture = await installationFixture();
  const child = new FakeChild();
  const killed = syntheticKill(child);
  const firstText = attachSyntheticWebSocketPeer(child);
  try {
    const factory = await createLocalCodexTransportFactory(
      {
        environment: { HOME: fixture.home },
        gracefulExitMs: 1,
        signalTimeoutMs: 10,
        spawnTimeoutMs: 100,
        webSocket: { closeTimeoutMs: 50, handshakeTimeoutMs: 100 },
      },
      {
        killProcess: killed.killProcess,
        loginHome: () => fixture.home,
        sleep: async () => undefined,
        spawn: () => {
          queueMicrotask(() => child.emit("spawn"));
          return child as never;
        },
      },
    );
    const transport = await factory.connectTransport();
    const firstPayload = '{"jsonrpc":"2.0","method":"initialize"}';
    await transport.send(firstPayload);
    assert.equal(await firstText, firstPayload);
    await transport.close();
    assert.equal(transport.cleanupConfirmed, true);
    await factory.close();
  } finally {
    await fixture.close();
  }
});

test("factory rejects a managed endpoint generation change during handshake", async () => {
  const fixture = await installationFixture();
  const child = new FakeChild();
  const transport = new FakeTransport();
  const killed = syntheticKill(child);
  try {
    const factory = await createLocalCodexTransportFactory(
      {
        environment: { HOME: fixture.home },
        gracefulExitMs: 1,
        signalTimeoutMs: 10,
        spawnTimeoutMs: 100,
      },
      {
        connectWebSocket: async () => {
          // A synthetic managed-release replacement after the handshake starts
          // changes the attested inode/size without executing either binary.
          await rm(fixture.binary);
          const replacement = "alternate binary; never executed\n";
          assert.equal(
            Buffer.byteLength(replacement),
            Buffer.byteLength("synthetic binary; never executed\n"),
          );
          await writeFile(fixture.binary, replacement, { mode: 0o700 });
          return transport;
        },
        killProcess: killed.killProcess,
        loginHome: () => fixture.home,
        sleep: async () => undefined,
        spawn: () => {
          queueMicrotask(() => child.emit("spawn"));
          return child as never;
        },
      },
    );
    await assert.rejects(
      factory.connectTransport(),
      (error: unknown) =>
        error instanceof LocalCodexTransportError &&
        error.code === "ENDPOINT_GENERATION_CHANGED",
    );
    assert.equal(transport.closed, true);
    assert.deepEqual(killed.signals, ["SIGTERM"]);
    await factory.close();
  } finally {
    await fixture.close();
  }
});

test("factory fails closed when discarded stderr crosses its bound during handshake", async () => {
  const fixture = await installationFixture();
  const child = new FakeChild();
  const transport = new FakeTransport();
  const killed = syntheticKill(child);
  try {
    const factory = await createLocalCodexTransportFactory(
      {
        environment: { HOME: fixture.home },
        gracefulExitMs: 1,
        maxStderrBytes: 4,
        signalTimeoutMs: 10,
        spawnTimeoutMs: 100,
      },
      {
        connectWebSocket: async () => {
          child.stderr.write(Buffer.from("discarded"));
          return transport;
        },
        killProcess: killed.killProcess,
        loginHome: () => fixture.home,
        sleep: async () => undefined,
        spawn: () => {
          queueMicrotask(() => child.emit("spawn"));
          return child as never;
        },
      },
    );
    await assert.rejects(
      factory.connectTransport(),
      (error: unknown) =>
        error instanceof LocalCodexTransportError &&
        error.code === "PROXY_STDERR_LIMIT",
    );
    assert.equal(transport.closed, true);
    assert.deepEqual(killed.signals, ["SIGTERM"]);
    await factory.close();
  } finally {
    await fixture.close();
  }
});

test("cleanup refuses any process group not exactly owned", async () => {
  const child = new FakeChild();
  assert.equal(
    await terminateOwnedLocalProxy(child as never, child.pid + 1, {
      gracefulExitMs: 1,
      signalTimeoutMs: 1,
    }),
    false,
  );
});
