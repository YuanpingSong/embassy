import { randomUUID } from "node:crypto";
import {
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { BridgeError } from "../errors.js";

const HOST_STATE_DIRECTORY = path.join(".local", "state", "agent-embassy");
const HOST_STATE_MARKER_FILE = ".agent-embassy-state";
const HOST_STATE_MARKER_CONTENT = "agent-embassy-state-v1\n";
const HOST_LOCK_FILE = ".gateway-host.lock";
const LEGACY_STATE_DIRECTORY = path.join(
  ".local",
  "state",
  "claude-agent-bridge",
  "gateway",
);
const LEGACY_MARKER_FILE = ".claude-codex-gateway-state";
const LEGACY_MARKER_CONTENT = "claude-codex-local-gateway-state-v1\n";
const LEGACY_LOCK_FILE = ".gateway-controller.lock";
const MAX_MARKER_BYTES = 128;
const MAX_LOCK_BYTES = 4 * 1024;
const LOCKF_PATH = "/usr/bin/lockf";
const CAT_PATH = "/bin/cat";
const HOST_LEASE_READY_TIMEOUT_MS = 5_000;
const HOST_LEASE_EXIT_TIMEOUT_MS = 5_000;

type LockRecord = Readonly<{
  schemaVersion: 1;
  pid: number;
  hostname: string;
  token: string;
}>;

export type GatewayInstanceLease = Readonly<{
  /** Resolves only if the host-wide kernel lease is lost unexpectedly. */
  lost: Promise<void>;
  isLost: () => boolean;
  close: () => Promise<void>;
}>;

type ProcessLease = Readonly<{
  close: () => Promise<void>;
}>;

export type GatewayInstanceLeaseDependencies = Readonly<{
  hostLeaseExitTimeoutMs?: number;
  spawnLeaseHelper?: (
    command: string,
    args: string[],
    options: Readonly<{
      env: NodeJS.ProcessEnv;
      stdio: ["pipe", "pipe", "pipe"];
    }>,
  ) => ChildProcessWithoutNullStreams;
}>;

type HostProcessLease = ProcessLease &
  Readonly<{
    lost: Promise<void>;
    isLost: () => boolean;
  }>;

type HostLeaseLossMonitor = Readonly<{
  lost: Promise<void>;
  isLost: () => boolean;
  assertHeld: () => void;
  expectClose: () => void;
  dispose: () => void;
}>;

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isLockRecord(value: unknown): value is LockRecord {
  if (!isObject(value)) return false;
  const keys = Object.keys(value);
  return (
    keys.length === 4 &&
    keys.every((key) =>
      ["schemaVersion", "pid", "hostname", "token"].includes(key),
    ) &&
    value.schemaVersion === 1 &&
    isPositiveInteger(value.pid) &&
    typeof value.hostname === "string" &&
    value.hostname.length > 0 &&
    value.hostname.length <= 255 &&
    typeof value.token === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value.token,
    )
  );
}

function assertPrivateOwned(
  uid: number,
  mode: number,
  description: string,
): void {
  if (typeof process.getuid === "function" && uid !== process.getuid()) {
    throw new BridgeError(
      "GATEWAY_INSTANCE_IN_USE",
      `${description} is not owned by the current process user.`,
      true,
    );
  }
  if ((mode & 0o077) !== 0) {
    throw new BridgeError(
      "GATEWAY_INSTANCE_IN_USE",
      `${description} is not private to the current process user.`,
      true,
    );
  }
}

async function readPrivateFile(
  filePath: string,
  maximumBytes: number,
): Promise<string> {
  const info = await lstat(filePath);
  if (info.isSymbolicLink() || !info.isFile() || info.size > maximumBytes) {
    throw new BridgeError(
      "GATEWAY_INSTANCE_IN_USE",
      "An Embassy instance-control file cannot be safely verified.",
      true,
    );
  }
  assertPrivateOwned(info.uid, info.mode, "An Embassy instance-control file");
  const handle = await open(
    filePath,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.dev !== info.dev ||
      opened.ino !== info.ino ||
      opened.size > maximumBytes
    ) {
      throw new BridgeError(
        "GATEWAY_INSTANCE_IN_USE",
        "An Embassy instance-control file changed during verification.",
        true,
      );
    }
    assertPrivateOwned(
      opened.uid,
      opened.mode,
      "An Embassy instance-control file",
    );
    const buffer = Buffer.alloc(maximumBytes + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        offset,
        buffer.length - offset,
        offset,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > maximumBytes) {
      throw new BridgeError(
        "GATEWAY_INSTANCE_IN_USE",
        "An Embassy instance-control file exceeds its bounded size.",
        true,
      );
    }
    return buffer.subarray(0, offset).toString("utf8");
  } finally {
    await handle.close();
  }
}

function waitForChildExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(
        new BridgeError(
          "GATEWAY_CLEANUP_FAILED",
          "Embassy could not confirm host-wide lease cleanup.",
        ),
      );
    }, timeoutMs);
    const onExit = (): void => {
      cleanup();
      resolve();
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      child.removeListener("exit", onExit);
    };
    child.once("exit", onExit);
  });
}

function waitForHostLeaseReady(
  child: ChildProcessWithoutNullStreams,
  challenge: string,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let output = "";
    let settled = false;
    const timer = setTimeout(() => {
      finish(
        new BridgeError(
          "GATEWAY_INSTANCE_IN_USE",
          "Another or unverifiable Embassy gateway owns this machine.",
          true,
        ),
      );
    }, HOST_LEASE_READY_TIMEOUT_MS);

    const cleanup = (): void => {
      clearTimeout(timer);
      child.stdout.removeListener("data", onData);
      child.removeListener("error", onError);
      child.removeListener("exit", onExit);
    };
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error === undefined) resolve();
      else reject(error);
    };
    const unavailable = (): BridgeError =>
      new BridgeError(
        "GATEWAY_INSTANCE_IN_USE",
        "Another or unverifiable Embassy gateway owns this machine.",
        true,
      );
    const onData = (chunk: Buffer | string): void => {
      output += chunk.toString();
      if (Buffer.byteLength(output, "utf8") > MAX_LOCK_BYTES) {
        finish(unavailable());
        return;
      }
      if (output === challenge) finish();
      else if (output.includes("\n")) finish(unavailable());
    };
    const onError = (): void => finish(unavailable());
    const onExit = (): void => finish(unavailable());
    const onStdinError = (): void => finish(unavailable());

    child.stdout.on("data", onData);
    child.once("error", onError);
    child.once("exit", onExit);
    // A contending lockf helper may exit before the challenge write reaches
    // its pipe. Its stdin then emits EPIPE/ERR_STREAM_DESTROYED in addition to
    // invoking the write callback. Treat that as the same bounded contention
    // outcome instead of allowing an unhandled stream error to escape.
    child.stdin.on("error", onStdinError);
    child.stdin.write(challenge, "utf8", (error) => {
      if (error !== null && error !== undefined) finish(unavailable());
    });
  });
}

function monitorHostLeaseLoss(
  child: ChildProcessWithoutNullStreams,
): HostLeaseLossMonitor {
  let resolveLost: (() => void) | undefined;
  let expectedClose = false;
  let lost = false;
  let disposed = false;
  const loss = new Promise<void>((resolve) => {
    resolveLost = resolve;
  });
  const markLost = (): void => {
    if (expectedClose || lost) return;
    lost = true;
    resolveLost?.();
  };
  const onError = (): void => markLost();
  const onExit = (): void => markLost();

  // Attach this monitor before the READY handshake. The handshake removes its
  // own temporary listeners when it resolves, so this permanent listener
  // closes the otherwise possible READY-to-monitor event gap.
  child.on("error", onError);
  child.on("exit", onExit);

  return {
    lost: loss,
    isLost: () => lost,
    assertHeld: () => {
      if (lost) {
        throw new BridgeError(
          "GATEWAY_INSTANCE_LEASE_LOST",
          "Embassy lost its host-wide gateway lease.",
          true,
        );
      }
    },
    expectClose: () => {
      expectedClose = true;
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      child.removeListener("error", onError);
      child.removeListener("exit", onExit);
    },
  };
}

async function acquireHostAdvisoryLease(
  directory: string,
  spawnLeaseHelper: NonNullable<
    GatewayInstanceLeaseDependencies["spawnLeaseHelper"]
  >,
  exitTimeoutMs: number,
): Promise<HostProcessLease> {
  const lockPath = path.join(directory, HOST_LOCK_FILE);
  const seed = await open(
    lockPath,
    constants.O_CREAT |
      constants.O_RDWR |
      (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  let seededDevice: number;
  let seededInode: number;
  try {
    const info = await seed.stat();
    if (!info.isFile()) {
      throw new BridgeError(
        "GATEWAY_INSTANCE_IN_USE",
        "The Embassy host lease is not a regular file.",
        true,
      );
    }
    assertPrivateOwned(info.uid, info.mode, "The Embassy host lease");
    seededDevice = info.dev;
    seededInode = info.ino;
  } finally {
    await seed.close();
  }

  const child = spawnLeaseHelper(
    LOCKF_PATH,
    ["-k", "-t", "0", lockPath, CAT_PATH],
    {
      env: {},
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const monitor = monitorHostLeaseLoss(child);
  const token = randomUUID();
  const challenge = `embassy-host-lease:${token}\n`;
  try {
    await waitForHostLeaseReady(child, challenge);
    monitor.assertHeld();
    const lockedInfo = await lstat(lockPath);
    if (
      lockedInfo.isSymbolicLink() ||
      !lockedInfo.isFile() ||
      lockedInfo.dev !== seededDevice ||
      lockedInfo.ino !== seededInode
    ) {
      throw new BridgeError(
        "GATEWAY_INSTANCE_IN_USE",
        "The Embassy host lease changed during acquisition.",
        true,
      );
    }
    assertPrivateOwned(
      lockedInfo.uid,
      lockedInfo.mode,
      "The Embassy host lease",
    );
    const record: LockRecord = {
      schemaVersion: 1,
      pid: process.pid,
      hostname: os.hostname(),
      token,
    };
    const recordHandle = await open(
      lockPath,
      constants.O_RDWR | (constants.O_NOFOLLOW ?? 0),
    );
    try {
      const opened = await recordHandle.stat();
      if (opened.dev !== seededDevice || opened.ino !== seededInode) {
        throw new BridgeError(
          "GATEWAY_INSTANCE_IN_USE",
          "The Embassy host lease changed during acquisition.",
          true,
        );
      }
      await recordHandle.truncate(0);
      await recordHandle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
      await recordHandle.sync();
    } finally {
      await recordHandle.close();
    }
    monitor.assertHeld();
  } catch (error) {
    monitor.expectClose();
    if (child.exitCode === null && child.signalCode === null) {
      child.stdin.end();
      child.kill("SIGTERM");
    }
    try {
      await waitForChildExit(child, exitTimeoutMs);
    } catch {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
      try {
        await waitForChildExit(child, exitTimeoutMs);
      } catch {
        throw new BridgeError(
          "GATEWAY_CLEANUP_FAILED",
          "Embassy could not confirm failed host-lease acquisition cleanup.",
        );
      }
    } finally {
      if (child.exitCode !== null || child.signalCode !== null) {
        monitor.dispose();
      }
    }
    if (error instanceof BridgeError) throw error;
    throw new BridgeError(
      "GATEWAY_INSTANCE_IN_USE",
      "Embassy could not acquire its host-wide gateway lease.",
      true,
    );
  }

  let closed = false;
  return {
    lost: monitor.lost,
    isLost: monitor.isLost,
    close: async () => {
      if (closed) return;
      closed = true;
      monitor.expectClose();
      if (child.exitCode === null && child.signalCode === null) {
        child.stdin.end();
      }
      try {
        await waitForChildExit(child, exitTimeoutMs);
      } catch (error) {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
          await waitForChildExit(child, exitTimeoutMs).catch(
            () => undefined,
          );
        }
        throw error;
      } finally {
        monitor.dispose();
      }
      // Deliberately keep the fixed lock file. Removing it after releasing the
      // kernel lock creates an unlink/recreate race in which a successor can
      // be locked on the old inode while a third process locks a new one.
      // Reusing one private inode preserves lock ordering across generations.
    },
  };
}

async function acquireProcessLease(
  directory: string,
  lockFileName: string,
): Promise<ProcessLease> {
  const lockPath = path.join(directory, lockFileName);
  const ownedToken = randomUUID();
  let handle: FileHandle;
  try {
    handle = await open(
      lockPath,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_RDWR |
        (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "EEXIST"
    ) {
      // The legacy controller did not participate in Embassy's kernel-held
      // host lease. Preserve any pre-existing legacy lock—live, stale, or
      // unverifiable—rather than path-reclaiming across that protocol boundary.
      await readPrivateFile(lockPath, MAX_LOCK_BYTES).catch(() => undefined);
      throw new BridgeError(
        "GATEWAY_INSTANCE_IN_USE",
        "A legacy or unverifiable gateway lock already exists.",
        true,
      );
    }
    throw error;
  }
  try {
    const record: LockRecord = {
      schemaVersion: 1,
      pid: process.pid,
      hostname: os.hostname(),
      token: ownedToken,
    };
    await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await unlink(lockPath).catch(() => undefined);
    throw error;
  }

  let closed = false;
  return {
    close: async () => {
      if (closed) return;
      closed = true;
      try {
        await handle.close();
      } catch {
        throw new BridgeError(
          "GATEWAY_CLEANUP_FAILED",
          "Embassy could not confirm legacy instance-lease cleanup.",
        );
      }
      try {
        const current = JSON.parse(
          await readPrivateFile(lockPath, MAX_LOCK_BYTES),
        );
        if (isLockRecord(current) && current.token === ownedToken) {
          await unlink(lockPath);
        }
      } catch (error) {
        if (
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT"
        ) {
          return;
        }
        throw new BridgeError(
          "GATEWAY_CLEANUP_FAILED",
          "Embassy could not confirm legacy instance-lease cleanup.",
        );
      }
    },
  };
}

async function ensureHostStateMarker(directory: string): Promise<void> {
  const markerPath = path.join(directory, HOST_STATE_MARKER_FILE);
  try {
    const marker = await readPrivateFile(markerPath, MAX_MARKER_BYTES);
    if (marker !== HOST_STATE_MARKER_CONTENT) {
      throw new BridgeError(
        "GATEWAY_INSTANCE_IN_USE",
        "The Embassy host-lease root has an unrecognized ownership marker.",
        true,
      );
    }
    return;
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      error.code !== "ENOENT"
    ) {
      throw error;
    }
  }

  // Claim only a genuinely empty root. In particular, do not make a
  // pre-existing non-empty directory look Embassy-owned merely because it is
  // at the default path.
  if ((await readdir(directory)).length > 0) {
    throw new BridgeError(
      "GATEWAY_INSTANCE_IN_USE",
      "The Embassy host-lease root is non-empty and has no ownership marker.",
      true,
    );
  }

  let marker: FileHandle;
  try {
    marker = await open(
      markerPath,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "EEXIST"
    ) {
      const racedMarker = await readPrivateFile(markerPath, MAX_MARKER_BYTES);
      if (racedMarker === HOST_STATE_MARKER_CONTENT) return;
      throw new BridgeError(
        "GATEWAY_INSTANCE_IN_USE",
        "The Embassy host-lease root has an unrecognized ownership marker.",
        true,
      );
    }
    throw error;
  }
  try {
    await marker.writeFile(HOST_STATE_MARKER_CONTENT, "utf8");
    await marker.chmod(0o600);
    await marker.sync();
  } finally {
    await marker.close();
  }
}

function validateLoginHome(loginHome: string): string {
  if (
    !path.isAbsolute(loginHome) ||
    path.resolve(loginHome) !== loginHome ||
    loginHome.includes("\0")
  ) {
    throw new BridgeError(
      "INVALID_GATEWAY_LOGIN_HOME",
      "Embassy requires the verified absolute login home.",
    );
  }
  return loginHome;
}

async function prepareHostLeaseDirectory(loginHome: string): Promise<string> {
  const homeInfo = await lstat(loginHome);
  if (
    homeInfo.isSymbolicLink() ||
    !homeInfo.isDirectory() ||
    (await realpath(loginHome)) !== loginHome ||
    (typeof process.getuid === "function" &&
      homeInfo.uid !== process.getuid())
  ) {
    throw new BridgeError(
      "GATEWAY_INSTANCE_IN_USE",
      "The verified login home is not a current-user real directory.",
      true,
    );
  }

  let current = loginHome;
  let leafCreated = false;
  const components = HOST_STATE_DIRECTORY.split(path.sep);
  for (const [index, component] of components.entries()) {
    current = path.join(current, component);
    try {
      await mkdir(current, { mode: 0o700 });
      if (index === components.length - 1) leafCreated = true;
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "EEXIST"
      ) {
        throw error;
      }
    }
    const info = await lstat(current);
    if (
      info.isSymbolicLink() ||
      !info.isDirectory() ||
      (typeof process.getuid === "function" && info.uid !== process.getuid()) ||
      (await realpath(current)) !== current
    ) {
      throw new BridgeError(
        "GATEWAY_INSTANCE_IN_USE",
        "An Embassy host-lease path component is not a current-user real directory.",
        true,
      );
    }
  }
  if (leafCreated) await chmod(current, 0o700);
  const leaf = await lstat(current);
  assertPrivateOwned(leaf.uid, leaf.mode, "The Embassy host lease root");
  await ensureHostStateMarker(current);
  return current;
}

async function recognizedLegacyRoot(
  loginHome: string,
): Promise<string | undefined> {
  const directory = path.join(loginHome, LEGACY_STATE_DIRECTORY);
  try {
    const info = await lstat(directory);
    if (info.isSymbolicLink() || !info.isDirectory()) return undefined;
    assertPrivateOwned(info.uid, info.mode, "The legacy gateway root");
    if ((await realpath(directory)) !== directory) return undefined;
    const marker = await readPrivateFile(
      path.join(directory, LEGACY_MARKER_FILE),
      MAX_MARKER_BYTES,
    );
    return marker === LEGACY_MARKER_CONTENT ? directory : undefined;
  } catch {
    // An absent, unsafe, or unrecognized legacy tree is never mutated.
    return undefined;
  }
}

/**
 * Acquire the one per-login-user Embassy controller lease. The fixed lease is
 * deliberately independent of EMBASSY_STATE_DIR. For one release, a genuine
 * legacy default state root is also leased so a still-running pre-rename
 * gateway cannot advertise a second Codex peer.
 */
export async function acquireGatewayInstanceLease(
  suppliedLoginHome: string,
  dependencies: GatewayInstanceLeaseDependencies = {},
): Promise<GatewayInstanceLease> {
  const loginHome = validateLoginHome(suppliedLoginHome);
  const hostDirectory = await prepareHostLeaseDirectory(loginHome);
  const leases: ProcessLease[] = [];
  let hostLease: HostProcessLease | undefined;
  try {
    // A kernel-held macOS lease makes state-directory overrides irrelevant and
    // disappears automatically if the gateway crashes. The PID/token record
    // is metadata for exact cleanup; it is never used for path-only reclaim.
    const spawnLeaseHelper =
      dependencies.spawnLeaseHelper ??
      ((command, args, options) => spawn(command, args, options));
    const exitTimeoutMs =
      dependencies.hostLeaseExitTimeoutMs ?? HOST_LEASE_EXIT_TIMEOUT_MS;
    if (
      !Number.isSafeInteger(exitTimeoutMs) ||
      exitTimeoutMs < 10 ||
      exitTimeoutMs > HOST_LEASE_EXIT_TIMEOUT_MS
    ) {
      throw new BridgeError(
        "GATEWAY_INSTANCE_IN_USE",
        "The Embassy host-lease cleanup bound is invalid.",
        true,
      );
    }
    hostLease = await acquireHostAdvisoryLease(
      hostDirectory,
      spawnLeaseHelper,
      exitTimeoutMs,
    );
    leases.push(hostLease);
    const legacyDirectory = await recognizedLegacyRoot(loginHome);
    if (legacyDirectory !== undefined) {
      leases.push(
        await acquireProcessLease(legacyDirectory, LEGACY_LOCK_FILE),
      );
    }
  } catch (error) {
    for (const lease of leases.reverse()) await lease.close();
    throw error;
  }

  let closed = false;
  return {
    lost: hostLease.lost,
    isLost: hostLease.isLost,
    close: async () => {
      if (closed) return;
      closed = true;
      const failures: unknown[] = [];
      for (const lease of leases.reverse()) {
        await lease.close().catch((error: unknown) => failures.push(error));
      }
      if (failures.length > 0) {
        throw new BridgeError(
          "GATEWAY_CLEANUP_FAILED",
          "Embassy could not confirm exact instance-lease cleanup.",
        );
      }
    },
  };
}
