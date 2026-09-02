import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { hostname as osHostname } from "node:os";
import path from "node:path";

import { BridgeError } from "../errors.js";

const NODES_FILE = "nodes.json";
const MAX_NODES_FILE_BYTES = 64 * 1024;
const MAX_HOSTS = 32;
const HOST_TOKEN = /^[a-z0-9](?:[a-z0-9.-]{0,61}[a-z0-9])?$/;
const ATTESTED = new WeakSet<object>();

export type GatewayNodeInventory = Readonly<{
  host: string;
  nodes: readonly string[];
}>;

export type GatewayNodeInventoryDependencies = Readonly<{
  lstat?: typeof lstat;
  open?: typeof open;
  realpath?: typeof realpath;
  getuid?: () => number | undefined;
  hostname?: () => string;
}>;

const attest = (inventory: GatewayNodeInventory): GatewayNodeInventory => {
  ATTESTED.add(inventory);
  return inventory;
};
export const isAttestedGatewayNodeInventory = (
  inventory: GatewayNodeInventory | undefined,
  host: string,
): boolean => inventory !== undefined && ATTESTED.has(inventory) && inventory.host === host;

const invalid = (message: string): never => {
  throw new BridgeError("INVALID_GATEWAY_CONFIGURATION", message);
};
const inaccessible = (error: unknown, message: string): never => {
  if (isErrno(error, "EPERM") || isErrno(error, "EACCES"))
    throw new BridgeError("CONTROL_CONNECT_DENIED", "Local policy denied access to the Embassy state directory.", true);
  return invalid(message);
};

function assertOwned(uid: number, getuid: () => number | undefined): void {
  const expected = getuid();
  if (expected !== undefined && uid !== expected) {
    invalid("The Embassy federation node inventory must be owned by the current process user.");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseInventory(text: string): GatewayNodeInventory {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return invalid("nodes.json must contain valid JSON.");
  }
  if (!isRecord(parsed) ||
      Object.keys(parsed).length !== 3 ||
      !Object.hasOwn(parsed, "version") ||
      !Object.hasOwn(parsed, "host") ||
      !Object.hasOwn(parsed, "nodes") ||
      parsed.version !== 1 ||
      typeof parsed.host !== "string" ||
      !HOST_TOKEN.test(parsed.host) ||
      !Array.isArray(parsed.nodes) ||
      parsed.nodes.some((node) => typeof node !== "string" || !HOST_TOKEN.test(node))) {
    return invalid("nodes.json must be exactly {version:1, host:<lowercase host>, nodes:[<lowercase host>...]}.");
  }
  const nodes = parsed.nodes as string[];
  if (nodes.length + 1 > MAX_HOSTS ||
      new Set(nodes).size !== nodes.length ||
      nodes.includes(parsed.host)) {
    return invalid("nodes.json must name 0 through 31 unique peer hosts, with the local host absent from nodes.");
  }
  return attest(Object.freeze({ host: parsed.host, nodes: Object.freeze([...nodes]) }));
}

/**
 * Absent nodes.json (and an absent state directory) is the single-machine
 * case: attest a federation-free default named by this machine's own short
 * hostname, falling back to "localhost" when that name fails HOST_TOKEN.
 */
function defaultInventory(hostname: () => string): GatewayNodeInventory {
  const label = hostname().split(".")[0]!.toLowerCase();
  const host = HOST_TOKEN.test(label) ? label : "localhost";
  return attest(Object.freeze({ host, nodes: Object.freeze([]) }));
}

/**
 * Load the static federation inventory from the already-selected Embassy state
 * directory. An absent state directory or absent nodes.json defaults to a
 * federation-free single-machine inventory named by this host's hostname; a
 * present-but-unreadable inventory still refuses.
 */
export async function loadGatewayNodeInventory(
  stateDir: string,
  dependencies: GatewayNodeInventoryDependencies = {},
): Promise<GatewayNodeInventory> {
  const inspect = dependencies.lstat ?? lstat;
  const resolve = dependencies.realpath ?? realpath;
  const openFile = dependencies.open ?? open;
  const getuid = dependencies.getuid ?? (() =>
    typeof process.getuid === "function" ? process.getuid() : undefined);
  const hostname = dependencies.hostname ?? osHostname;
  if (!path.isAbsolute(stateDir) || path.resolve(stateDir) !== stateDir) {
    return invalid("The Embassy state directory for nodes.json must be an absolute normalized path.");
  }
  let root: Awaited<ReturnType<typeof lstat>>;
  try { root = await inspect(stateDir); } catch (error) {
    if (isErrno(error, "ENOENT")) return defaultInventory(hostname);
    return inaccessible(error, "The Embassy state directory for nodes.json cannot be safely verified.");
  }
  if (root.isSymbolicLink() || !root.isDirectory() || (root.mode & 0o777) !== 0o700) {
    return invalid("The Embassy state directory for nodes.json must be a private mode-0700 directory.");
  }
  assertOwned(root.uid, getuid);
  if (await resolve(stateDir).catch(() => undefined) !== stateDir) {
    return invalid("The Embassy state directory for nodes.json must not traverse symbolic links.");
  }

  const filePath = path.join(stateDir, NODES_FILE);
  let before: Awaited<ReturnType<typeof lstat>>;
  try {
    before = await inspect(filePath);
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      return defaultInventory(hostname);
    }
    return inaccessible(error, "nodes.json cannot be safely inspected.");
  }
  if (before.isSymbolicLink() || !before.isFile() ||
      (before.mode & 0o777) !== 0o600 || before.size > MAX_NODES_FILE_BYTES) {
    return invalid("nodes.json must be a mode-0600 regular file no larger than 64 KiB.");
  }
  assertOwned(before.uid, getuid);

  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await openFile(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    return inaccessible(error, "nodes.json cannot be safely opened.");
  }
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino ||
        (opened.mode & 0o777) !== 0o600 || opened.size > MAX_NODES_FILE_BYTES) {
      return invalid("nodes.json changed during verification.");
    }
    assertOwned(opened.uid, getuid);
    const buffer = Buffer.alloc(MAX_NODES_FILE_BYTES + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > MAX_NODES_FILE_BYTES) {
      return invalid("nodes.json must be no larger than 64 KiB.");
    }
    const after = await handle.stat();
    if (after.dev !== opened.dev || after.ino !== opened.ino ||
        after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) {
      return invalid("nodes.json changed while it was being read.");
    }
    return parseInventory(buffer.subarray(0, offset).toString("utf8"));
  } catch (error) {
    if (error instanceof BridgeError) throw error;
    if (!isErrnoShape(error)) throw error;
    return inaccessible(error, "nodes.json cannot be safely read.");
  } finally {
    await handle.close();
  }
}

function isErrno(error: unknown, code: string): boolean {
  return isErrnoShape(error) && error.code === code;
}

function isErrnoShape(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null &&
    "code" in error && typeof (error as NodeJS.ErrnoException).code === "string";
}
