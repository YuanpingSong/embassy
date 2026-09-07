import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, readFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { BridgeError } from "../errors.js";

type Provider = "claude" | "codex";
type SkillFile = { relative: string; contents: Buffer };
type Target = { provider: Provider; path: string; status: "absent" | "current" | "stale" };
const errno = (error: unknown, code: string): boolean =>
  typeof error === "object" && error !== null && "code" in error && error.code === code;
const unsafe = (): never => { throw new BridgeError("SKILLS_TARGET_UNSAFE", "A skill target is not an owned real directory or file."); };

async function inspect(target: string, uid: number, directory: boolean): Promise<boolean> {
  try {
    const info = await lstat(target);
    if (info.uid !== uid || info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile())) return unsafe();
    return true;
  } catch (error) {
    if (errno(error, "ENOENT")) return false;
    throw error;
  }
}

async function packageFiles(root: string): Promise<{ files: SkillFile[]; directories: string[] }> {
  const files: SkillFile[] = [], directories = [""];
  const visit = async (relative: string): Promise<void> => {
    const entries = await readdir(path.join(root, relative), { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const child = path.join(relative, entry.name);
      if (entry.isDirectory()) { directories.push(child); await visit(child); }
      else if (entry.isFile()) files.push({ relative: child, contents: await readFile(path.join(root, child)) });
      else throw new Error("Not a packaged regular file");
    }
  };
  try {
    if (!(await lstat(root)).isDirectory()) throw new Error("Missing packaged skill directory");
    await visit("");
    if (!files.some((file) => file.relative === "SKILL.md")) throw new Error("Missing packaged skill");
    return { files, directories };
  } catch {
    throw new BridgeError("SKILLS_PACKAGE_INVALID", "The running installation lacks a valid packaged skill.");
  }
}

async function sameFile(target: string, expected: Buffer, uid: number): Promise<boolean> {
  if (!await inspect(target, uid, false)) return false;
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.uid !== uid) return unsafe();
    return info.size === expected.length && (await handle.readFile()).equals(expected);
  } finally { await handle.close(); }
}

async function replaceFile(target: string, contents: Buffer): Promise<void> {
  const temporary = path.join(path.dirname(target), `.embassy-${randomUUID()}.tmp`);
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(contents);
    await handle.close();
    await rename(temporary, target);
  } finally {
    await handle.close();
    await rm(temporary, { force: true });
  }
}

/** Local operator command: no gateway inventory, caller identity, or provider I/O. */
export async function runCoreSkillsCommand(
  subcommand: "install" | "status",
  providers: readonly Provider[],
  env: NodeJS.ProcessEnv,
  dependencies: { sourceDir?: string; uid?: number } = {},
): Promise<{ subcommand: "install" | "status"; targets: { provider: Provider; path: string; status: string }[] }> {
  const home = env.HOME ?? homedir();
  if (!path.isAbsolute(home)) throw new BridgeError("INVALID_ARGUMENTS", "HOME must be an absolute path.");
  const uid = dependencies.uid ?? process.getuid!();
  // Source execution (tsx) and the shipped dist/src/gateway entry use the same installation.
  const source = dependencies.sourceDir ?? fileURLToPath(new URL(
    import.meta.url.endsWith(".ts") ? "../../skills/embassy-peer/" : "../../../skills/embassy-peer/", import.meta.url));
  const { files, directories } = await packageFiles(source);
  try {
    if (!await inspect(home, uid, true)) throw new BridgeError("SKILLS_TARGET_UNSAFE", "HOME is not an owned directory.");
    const targets: Target[] = [];
    const parents = (provider: Provider): string[] => [path.join(home, `.${provider}`), path.join(home, `.${provider}`, "skills")];
    // Validate every selected destination before the first mkdir or replacement.
    for (const provider of providers) {
      for (const parent of parents(provider)) await inspect(parent, uid, true);
      const target = path.join(home, `.${provider}`, "skills", "embassy-peer");
      const exists = await inspect(target, uid, true);
      for (const directory of directories) await inspect(path.join(target, directory), uid, true);
      let current = exists;
      for (const file of files) {
        if (!await sameFile(path.join(target, file.relative), file.contents, uid)) current = false;
      }
      targets.push({ provider, path: target, status: !exists ? "absent" : current ? "current" : "stale" });
    }
    if (subcommand === "status") return { subcommand, targets };
    const results = [];
    for (const target of targets) {
      if (target.status === "current") { results.push({ ...target, status: "unchanged" }); continue; }
      for (const directory of [...parents(target.provider), ...directories.map((relative) => path.join(target.path, relative))]) {
        if (!await inspect(directory, uid, true)) await mkdir(directory, { mode: 0o700 });
      }
      for (const file of files) {
        const destination = path.join(target.path, file.relative);
        if (!await sameFile(destination, file.contents, uid)) await replaceFile(destination, file.contents);
      }
      results.push({ provider: target.provider, path: target.path, status: target.status === "absent" ? "installed" : "updated" });
    }
    return { subcommand, targets: results };
  } catch (error) {
    if (error instanceof BridgeError) throw error;
    throw new BridgeError("SKILLS_FILESYSTEM_FAILED", "The skill filesystem operation could not complete.");
  }
}
