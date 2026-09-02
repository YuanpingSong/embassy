import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, open, realpath, rename, unlink } from "node:fs/promises";
import { hostname as osHostname } from "node:os";
import path from "node:path";

import { BridgeError } from "../errors.js";

const NODES_FILE = "nodes.json";
const MAX_NODES_FILE_BYTES = 64 * 1024;
const MAX_HOSTS = 32;
const HOST_TOKEN = /^[a-z0-9](?:[a-z0-9.-]{0,61}[a-z0-9])?$/;
const ATTESTED = new WeakSet<object>();
/**
 * Inventories that were defaulted rather than read from a file. Kept parallel
 * to ATTESTED so the attested object's own shape stays exactly {host, nodes};
 * the CLI reads this to say where a local host identity came from.
 */
const DEFAULTED = new WeakSet<object>();

export type GatewayNodeInventory = Readonly<{
  host: string;
  nodes: readonly string[];
}>;

export type GatewayNodeInventoryDependencies = Readonly<{
  lstat?: typeof lstat;
  open?: typeof open;
  realpath?: typeof realpath;
  link?: typeof link;
  getuid?: () => number | undefined;
  hostname?: () => string;
  randomId?: () => string;
}>;

const attest = (inventory: GatewayNodeInventory): GatewayNodeInventory => {
  ATTESTED.add(inventory);
  return inventory;
};
export const isAttestedGatewayNodeInventory = (
  inventory: GatewayNodeInventory | undefined,
  host: string,
): boolean => inventory !== undefined && ATTESTED.has(inventory) && inventory.host === host;
/** True when this inventory is the transient hostname-derived default, not a file. */
export const isDefaultedGatewayNodeInventory = (
  inventory: GatewayNodeInventory | undefined,
): boolean => inventory !== undefined && DEFAULTED.has(inventory);

const invalid = (message: string): never => {
  throw new BridgeError("INVALID_GATEWAY_CONFIGURATION", message);
};
const inaccessible = (error: unknown, message: string): never => {
  if (isErrno(error, "EPERM") || isErrno(error, "EACCES"))
    throw new BridgeError("CONTROL_CONNECT_DENIED", "Local policy denied access to the Embassy state directory.", true);
  return invalid(message);
};
/**
 * A first-boot write that fails is not a misconfiguration: ENOSPC, EDQUOT,
 * EROFS, EIO, EMFILE and their kin are full disks and sick filesystems, and
 * calling them INVALID_GATEWAY_CONFIGURATION would send the operator to edit
 * a file that is fine. Only a real denial keeps the CONTROL_CONNECT_DENIED
 * class shared with every other access check here; everything else is a
 * recoverable write failure naming its errno and the path it failed on.
 */
const writeFailed = (error: unknown, filePath: string, what = "could not be durably written"): never => {
  if (isErrno(error, "EPERM") || isErrno(error, "EACCES"))
    throw new BridgeError("CONTROL_CONNECT_DENIED", "Local policy denied access to the Embassy state directory.", true);
  const code = isErrnoShape(error) ? error.code ?? "UNKNOWN" : "UNKNOWN";
  throw new BridgeError(
    "GATEWAY_STATE_WRITE_FAILED",
    `nodes.json ${what}: ${code} at ${filePath}.`,
    true,
  );
};
/**
 * Hard links are the no-clobber install, but exFAT, SMB and other homes
 * either refuse them (ENOTSUP/EOPNOTSUPP/EPERM) or cannot cross into the
 * target (EXDEV). Fall back to lstat-then-rename there: the check is a
 * best-effort no-clobber rather than an atomic one, which is the most those
 * filesystems can offer, and a first boot on them still succeeds.
 */
const LINK_UNSUPPORTED = ["ENOTSUP", "EOPNOTSUPP", "EPERM", "EXDEV"] as const;
async function installByRename(tempPath: string, filePath: string): Promise<boolean> {
  try {
    await lstat(filePath);
    return false;
  } catch (error) {
    if (!isErrno(error, "ENOENT")) throw error;
  }
  await rename(tempPath, filePath);
  return true;
}

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
  const inventory = attest(Object.freeze({ host, nodes: Object.freeze([]) }));
  DEFAULTED.add(inventory);
  return inventory;
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

async function writeDefaultInventoryFile(
  stateDir: string,
  host: string,
  openFile: typeof open,
  doLink: typeof link,
  randomId: () => string,
): Promise<void> {
  const filePath = path.join(stateDir, NODES_FILE);
  const tempPath = path.join(stateDir, `.nodes-${randomId()}.json.tmp`);
  const body = `${JSON.stringify({ version: 1, host, nodes: [] })}\n`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await openFile(tempPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
  } catch (error) {
    return writeFailed(error, tempPath);
  }
  const file = handle;
  let installed = false;
  try {
    // A restrictive umask or an inherited default ACL can leave the created
    // file at a mode the reload below would refuse; set it exactly, the same
    // way the durable state file is written.
    await file.chmod(0o600);
    await file.writeFile(body, "utf8");
    await file.sync();
    await file.close();
    handle = undefined;
    try {
      // link, not rename: a nodes.json that appeared in the window between
      // the absence check and here is never clobbered. EEXIST means another
      // writer won that race, and their file stands untouched — the reload
      // then reads whatever is actually installed.
      await doLink(tempPath, filePath);
      installed = true;
    } catch (error) {
      if (isErrno(error, "EEXIST")) installed = false;
      else if (LINK_UNSUPPORTED.some((code) => isErrno(error, code))) installed = await installByRename(tempPath, filePath);
      else throw error;
    }
  } catch (error) {
    return writeFailed(error, filePath);
  } finally {
    // Every path leaves the directory as it found it apart from the install:
    // the temp link is dropped after a success, a failure, or a lost race.
    await handle?.close().catch(() => undefined);
    await unlink(tempPath).catch(() => undefined);
  }
  // The file exists now; only the directory entry is still unflushed, so a
  // failure here says exactly that rather than claiming nothing was written.
  try {
    const directory = await openFile(stateDir, constants.O_RDONLY);
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch (error) {
    return writeFailed(error, stateDir, "was written but the Embassy state directory could not be synced");
  }
  if (installed) process.stderr.write(`[embassy] wrote nodes.json naming this host ${host} in ${stateDir}\n`);
}

/**
 * Broker-boot-only (emb-106 correction): call once, after the state
 * directory is claimed and its controller lock is held. A present nodes.json
 * is never rewritten — this only fires on a truly first-ever boot of this
 * state directory. Otherwise it atomically writes the exact schema
 * parseInventory expects (temp file + link, mode 0600) for `host`, then
 * reloads it through loadGatewayNodeInventory: the running broker's identity
 * becomes the file's from this point on, never the transient in-memory
 * default from defaultInventory() above. A write failure refuses — denied
 * as CONTROL_CONNECT_DENIED, anything else as GATEWAY_STATE_WRITE_FAILED —
 * and a reload that comes back defaulted (the file removed under us) refuses
 * as GATEWAY_NODE_INVENTORY_CHANGED, so a boot never runs on an identity
 * that is not the one on disk.
 *
 * The CLI never calls this. Its own transient default (defaultInventory)
 * stays live only for the narrow window before any broker has ever booted
 * on this state directory — for example, a client command run before the
 * first `embassy serve`.
 */
export async function ensureGatewayNodeInventoryFile(
  stateDir: string,
  host: string,
  dependencies: GatewayNodeInventoryDependencies = {},
): Promise<GatewayNodeInventory> {
  const inspect = dependencies.lstat ?? lstat;
  const filePath = path.join(stateDir, NODES_FILE);
  let present = true;
  try {
    await inspect(filePath);
  } catch (error) {
    if (isErrno(error, "ENOENT")) present = false;
    else return inaccessible(error, "nodes.json cannot be safely inspected.");
  }
  if (!present) {
    await writeDefaultInventoryFile(
      stateDir, host,
      dependencies.open ?? open, dependencies.link ?? link, dependencies.randomId ?? randomUUID,
    );
  }
  const reloaded = await loadGatewayNodeInventory(stateDir, dependencies);
  // A defaulted reload means the file is absent again: it was removed between
  // the install and this read. Running would put the broker back on the
  // transient identity this function exists to retire, so it refuses.
  if (isDefaultedGatewayNodeInventory(reloaded)) {
    throw new BridgeError(
      "GATEWAY_NODE_INVENTORY_CHANGED",
      `nodes.json at ${filePath} is absent again immediately after it was installed; it was removed while the broker was starting.`,
    );
  }
  return reloaded;
}

function isErrno(error: unknown, code: string): boolean {
  return isErrnoShape(error) && error.code === code;
}

function isErrnoShape(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null &&
    "code" in error && typeof (error as NodeJS.ErrnoException).code === "string";
}
