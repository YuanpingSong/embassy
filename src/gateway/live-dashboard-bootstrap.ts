import { randomBytes } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rmdir,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import path from "node:path";

import {
  assertDashboardLocale,
  getDashboardCopy,
  type DashboardLocale,
} from "./dashboard-copy.js";

export type LiveDashboardRandomBytes = (size: number) => Uint8Array;

type FileIdentity = Readonly<{
  device: number;
  inode: number;
}>;

export type LiveDashboardFileStat = Readonly<{
  dev: number;
  ino: number;
  mode: number;
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}>;

export type LiveDashboardFileHandle = Pick<
  FileHandle,
  "writeFile" | "sync" | "stat" | "close"
>;

export type LiveDashboardFileSystem = Readonly<{
  lstat(pathname: string): Promise<LiveDashboardFileStat>;
  mkdir(pathname: string, options: { mode: number }): Promise<void>;
  open(
    pathname: string,
    flags: "wx",
    mode: number,
  ): Promise<LiveDashboardFileHandle>;
  readdir(pathname: string): Promise<string[]>;
  realpath(pathname: string): Promise<string>;
  unlink(pathname: string): Promise<void>;
  rmdir(pathname: string): Promise<void>;
}>;

export const defaultLiveDashboardFileSystem: LiveDashboardFileSystem = {
  lstat,
  mkdir: async (pathname, options) => {
    await mkdir(pathname, options);
  },
  open,
  readdir,
  realpath,
  unlink,
  rmdir,
};

function identity(stat: LiveDashboardFileStat): FileIdentity {
  return { device: stat.dev, inode: stat.ino };
}

function sameIdentity(
  stat: LiveDashboardFileStat,
  expected: FileIdentity,
): boolean {
  return stat.dev === expected.device && stat.ino === expected.inode;
}

function base64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function bootstrapDocument(target: string, lang: DashboardLocale): string {
  const copy = getDashboardCopy(lang);
  const escaped = escapeHtml(target);
  return `<!doctype html>
<html lang="${lang}"><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; navigate-to http://127.0.0.1:*"><meta http-equiv="refresh" content="0;url=${escaped}"><title>${escapeHtml(copy["live.bootstrap.title"])}</title></head><body><p><a rel="noreferrer" href="${escaped}">${escapeHtml(copy["live.bootstrap.open"])}</a></p></body></html>`;
}

export type LiveDashboardBootstrapArtifacts = Readonly<{
  bootstrapPath: string;
  capability: string;
  close(): Promise<void>;
}>;

export async function createLiveDashboardBootstrap(
  options: Readonly<{
    privateStateRoot: string;
    bootstrapTargetWithoutFragment: string;
    lang: DashboardLocale;
    fileSystem?: LiveDashboardFileSystem;
    random?: LiveDashboardRandomBytes;
  }>,
): Promise<LiveDashboardBootstrapArtifacts> {
  assertDashboardLocale(options.lang);
  const fileSystem = options.fileSystem ?? defaultLiveDashboardFileSystem;
  const random = options.random ?? randomBytes;
  const targetMatch =
    /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})\/[A-Za-z0-9_-]{16,128}\/bootstrap$/u.exec(
      options.bootstrapTargetWithoutFragment,
    );
  if (targetMatch === null || Number(targetMatch[1]) > 65_535) {
    throw new Error("LIVE_DASHBOARD_BOOTSTRAP_TARGET_INVALID");
  }
  const requestedRoot = path.resolve(options.privateStateRoot);
  const rootPath = await fileSystem.realpath(requestedRoot);
  const rootStat = await fileSystem.lstat(rootPath);
  if (
    !rootStat.isDirectory() ||
    rootStat.isSymbolicLink() ||
    (rootStat.mode & 0o077) !== 0
  ) {
    throw new Error("LIVE_DASHBOARD_STATE_ROOT_NOT_PRIVATE");
  }
  let runDirectory = "";
  let runIdentity: FileIdentity | undefined;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const name = `live-${base64Url(random(16))}`;
    if (!/^live-[A-Za-z0-9_-]{22}$/u.test(name)) {
      throw new Error("LIVE_DASHBOARD_RANDOM_SOURCE_INVALID");
    }
    const candidate = path.join(rootPath, name);
    try {
      await fileSystem.mkdir(candidate, { mode: 0o700 });
      const candidateStat = await fileSystem.lstat(candidate);
      if (
        !candidateStat.isDirectory() ||
        candidateStat.isSymbolicLink() ||
        (candidateStat.mode & 0o077) !== 0
      ) {
        throw new Error("LIVE_DASHBOARD_RUN_DIRECTORY_NOT_PRIVATE");
      }
      runDirectory = candidate;
      runIdentity = identity(candidateStat);
      break;
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "EEXIST"
      ) {
        continue;
      }
      throw error;
    }
  }
  if (runIdentity === undefined) {
    throw new Error("LIVE_DASHBOARD_RUN_DIRECTORY_COLLISION");
  }

  const capability = base64Url(random(32));
  if (!/^[A-Za-z0-9_-]{43}$/u.test(capability)) {
    throw new Error("LIVE_DASHBOARD_RANDOM_SOURCE_INVALID");
  }
  const target = `${options.bootstrapTargetWithoutFragment}#${capability}`;
  const bootstrapPath = path.join(runDirectory, "bootstrap.html");
  let handle: LiveDashboardFileHandle | undefined;
  let bootstrapIdentity: FileIdentity | undefined;
  try {
    handle = await fileSystem.open(bootstrapPath, "wx", 0o600);
    const openedStat = await handle.stat();
    if (
      !openedStat.isFile() ||
      openedStat.isSymbolicLink() ||
      (openedStat.mode & 0o177) !== 0
    ) {
      throw new Error("LIVE_DASHBOARD_BOOTSTRAP_NOT_PRIVATE");
    }
    bootstrapIdentity = identity(openedStat);
    await handle.writeFile(bootstrapDocument(target, options.lang), {
      encoding: "utf8",
    });
    await handle.sync();
    await handle.close();
    handle = undefined;
    const bootstrapStat = await fileSystem.lstat(bootstrapPath);
    if (
      !bootstrapStat.isFile() ||
      bootstrapStat.isSymbolicLink() ||
      (bootstrapStat.mode & 0o177) !== 0
    ) {
      throw new Error("LIVE_DASHBOARD_BOOTSTRAP_NOT_PRIVATE");
    }
    if (!sameIdentity(bootstrapStat, bootstrapIdentity)) {
      throw new Error("LIVE_DASHBOARD_BOOTSTRAP_REPLACED");
    }
  } catch (error) {
    await handle?.close().catch(() => undefined);
    try {
      const currentRun = await fileSystem.lstat(runDirectory);
      if (sameIdentity(currentRun, runIdentity)) {
        const entries = await fileSystem.readdir(runDirectory);
        if (entries.length === 1 && entries[0] === "bootstrap.html") {
          const currentBootstrap = await fileSystem.lstat(bootstrapPath);
          if (
            bootstrapIdentity !== undefined &&
            sameIdentity(currentBootstrap, bootstrapIdentity) &&
            currentBootstrap.isFile() &&
            !currentBootstrap.isSymbolicLink()
          ) {
            await fileSystem.unlink(bootstrapPath);
          }
        }
        if ((await fileSystem.readdir(runDirectory)).length === 0) {
          await fileSystem.rmdir(runDirectory);
        }
      }
    } catch {
      // Never broaden cleanup after a startup error. A private empty artifact
      // is preferable to deleting a path whose exact ownership changed.
    }
    throw error;
  }

  let closed = false;
  return {
    bootstrapPath,
    capability,
    close: async () => {
      if (closed) return;
      const currentRun = await fileSystem.lstat(runDirectory);
      if (
        !sameIdentity(currentRun, runIdentity) ||
        !currentRun.isDirectory() ||
        currentRun.isSymbolicLink()
      ) {
        throw new Error("LIVE_DASHBOARD_RUN_DIRECTORY_REPLACED");
      }
      const entries = await fileSystem.readdir(runDirectory);
      if (entries.length !== 1 || entries[0] !== "bootstrap.html") {
        throw new Error("LIVE_DASHBOARD_RUN_DIRECTORY_NOT_EXACT_OWNED");
      }
      const currentBootstrap = await fileSystem.lstat(bootstrapPath);
      if (
        bootstrapIdentity === undefined ||
        !sameIdentity(currentBootstrap, bootstrapIdentity) ||
        !currentBootstrap.isFile() ||
        currentBootstrap.isSymbolicLink()
      ) {
        throw new Error("LIVE_DASHBOARD_BOOTSTRAP_REPLACED");
      }
      await fileSystem.unlink(bootstrapPath);
      await fileSystem.rmdir(runDirectory);
      closed = true;
    },
  };
}
