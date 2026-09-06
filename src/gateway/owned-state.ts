import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { BridgeError } from "../errors.js";
import { KeyedMutex } from "../mutex.js";

const STATE_MARKER = ".agent-embassy-state";
const STATE_MARKER_CONTENT = "agent-embassy-state-v1\n";
const STATE_FILE = "gateway-state.json";
const MAX_MARKER_FILE_BYTES = 128;
const MAX_DOCUMENT_BYTES = 8 * 1024 * 1024;

export type OwnedStateCommit = Readonly<{ sequence: number; id: string }>;

export type OwnedStateDocument = Readonly<{
  schemaVersion: number;
  commit: OwnedStateCommit;
}>;

export type OwnedStateCodec<T extends OwnedStateDocument> = Readonly<{
  schemaVersion: number;
  maximumBytes: number;
  decode: (value: unknown) => T | undefined;
  create: (input: Readonly<{ now: Date; commit: OwnedStateCommit }>) => T;
  assertBounds?: (value: T) => void;
}>;

export type OwnedStateDependencies = Readonly<{
  now?: () => Date;
  randomId?: () => string;
  renameStateFile?: (source: string, target: string) => Promise<void>;
  afterStateFileRename?: () => void | Promise<void>;
}>;

class PostRenamePersistenceError extends BridgeError {
  constructor() {
    super(
      "GATEWAY_STATE_COMMIT_OUTCOME_UNKNOWN",
      "The installed state commit could not be verified. The controller was disabled and requires recovery.",
    );
    this.name = "PostRenamePersistenceError";
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function sameCommit(
  left: OwnedStateDocument | undefined,
  right: OwnedStateDocument | undefined,
): boolean {
  return left === undefined || right === undefined
    ? left === right
    : left.commit.sequence === right.commit.sequence && left.commit.id === right.commit.id;
}

async function assertNoSymlinkComponents(candidate: string): Promise<void> {
  let cursor = path.resolve(candidate);
  while (true) {
    try {
      const info = await lstat(cursor);
      if (info.isSymbolicLink()) {
        throw new BridgeError(
          "UNSAFE_GATEWAY_STATE_DIRECTORY",
          "The gateway state path cannot contain symbolic links.",
        );
      }
    } catch (error) {
      if (!isErrno(error, "ENOENT")) throw error;
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
}

async function canonicalFuturePath(candidate: string): Promise<string> {
  const absolute = path.resolve(candidate);
  const parsed = path.parse(absolute);
  const parts = absolute.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let cursor = parsed.root;
  for (let index = 0; index < parts.length; index += 1) {
    const next = path.join(cursor, parts[index]!);
    try {
      cursor = await realpath(next);
    } catch (error) {
      if (isErrno(error, "ENOENT")) return path.join(cursor, ...parts.slice(index));
      throw error;
    }
  }
  return cursor;
}

/**
 * One owned, bounded JSON document. The caller's host-wide instance lease is
 * the process-exclusion boundary; this class deliberately creates no second
 * PID lock. Domain transitions and restart settlement belong to the ledger.
 */
export class OwnedStateFile<T extends OwnedStateDocument> {
  rootDir: string;
  private readonly codec: OwnedStateCodec<T>;
  private readonly now: () => Date;
  private readonly randomId: () => string;
  private readonly renameStateFile: (source: string, target: string) => Promise<void>;
  private readonly afterStateFileRename: (() => void | Promise<void>) | undefined;
  private readonly mutex = new KeyedMutex();
  private state: T | undefined;
  private poisoned = false;

  constructor(
    stateDir: string,
    codec: OwnedStateCodec<T>,
    dependencies: OwnedStateDependencies = {},
  ) {
    if (
      !Number.isSafeInteger(codec.schemaVersion) || codec.schemaVersion < 1 ||
      !Number.isSafeInteger(codec.maximumBytes) || codec.maximumBytes < 1 ||
      codec.maximumBytes > MAX_DOCUMENT_BYTES
    ) {
      throw new BridgeError(
        "INVALID_GATEWAY_CONFIGURATION",
        "The owned state document limits are invalid.",
      );
    }
    this.rootDir = path.resolve(stateDir);
    this.codec = codec;
    this.now = dependencies.now ?? (() => new Date());
    this.randomId = dependencies.randomId ?? randomUUID;
    this.renameStateFile = dependencies.renameStateFile ?? rename;
    this.afterStateFileRename = dependencies.afterStateFileRename;
  }

  get stateFilePath(): string {
    return path.join(this.rootDir, STATE_FILE);
  }

  async initialize(): Promise<void> {
    await this.mutex.run("owned-state", async () => {
      if (this.poisoned) throw new PostRenamePersistenceError();
      if (this.state !== undefined) return;
      this.rootDir = await this.prepareOwnedDirectory();
      const loaded = await this.loadStateFile();
      if (loaded !== undefined) {
        this.state = loaded;
        return;
      }
      const initial = this.codec.create({
        now: this.now(),
        commit: { sequence: 0, id: this.randomId() },
      });
      this.assertDocument(initial);
      await this.persist(initial, undefined);
      this.state = initial;
    });
  }

  async snapshot(): Promise<T> {
    return this.mutex.run("owned-state", async () => structuredClone(this.requireState()));
  }

  async transact<R>(operation: (draft: T, now: Date) => R): Promise<R> {
    return this.mutex.run("owned-state", async () => {
      const current = this.requireState();
      const draft = structuredClone(current);
      const result = operation(draft, this.now());
      if (
        (typeof result === "object" || typeof result === "function") &&
        result !== null && "then" in result
      ) {
        throw new TypeError("Owned state transactions must be synchronous.");
      }
      if (JSON.stringify(draft) === JSON.stringify(current)) {
        return structuredClone(result);
      }
      const mutable = draft as T & { commit: OwnedStateCommit };
      mutable.commit = {
        sequence: current.commit.sequence + 1,
        id: this.randomId(),
      };
      this.assertDocument(draft);
      const isolatedResult = structuredClone(result);
      await this.persist(draft, current);
      this.state = draft;
      return isolatedResult;
    });
  }

  async close(): Promise<void> {
    await this.mutex.run("owned-state", async () => {
      this.state = undefined;
    });
  }

  private requireState(): T {
    if (this.poisoned) throw new PostRenamePersistenceError();
    if (this.state === undefined) {
      throw new BridgeError(
        "GATEWAY_NOT_INITIALIZED",
        "The owned state document has not been initialized.",
      );
    }
    return this.state;
  }

  private assertDocument(value: T): void {
    if (
      value.schemaVersion !== this.codec.schemaVersion ||
      this.codec.decode(structuredClone(value)) === undefined
    ) {
      throw new BridgeError(
        "CORRUPT_GATEWAY_STATE",
        "The gateway controller state failed strict schema validation.",
      );
    }
    this.codec.assertBounds?.(value);
  }

  private assertOwnedPrivate(uid: number, mode: number, kind: "directory" | "file"): void {
    if (typeof process.getuid === "function" && uid !== process.getuid()) {
      throw new BridgeError(
        "UNSAFE_GATEWAY_STATE_DIRECTORY",
        `The gateway state ${kind} is not owned by the current process user.`,
      );
    }
    const expected = kind === "directory" ? 0o700 : 0o600;
    if ((mode & 0o777) !== expected) {
      throw new BridgeError(
        "UNSAFE_GATEWAY_STATE_DIRECTORY",
        `The gateway state ${kind} must use exact mode ${expected.toString(8)}.`,
      );
    }
  }

  private async prepareOwnedDirectory(): Promise<string> {
    const requested = path.resolve(this.rootDir);
    await assertNoSymlinkComponents(requested);
    const canonical = await canonicalFuturePath(requested);
    const home = await realpath(os.homedir()).catch(() => path.resolve(os.homedir()));
    const temporaryRoot = await realpath(os.tmpdir()).catch(() => path.resolve(os.tmpdir()));
    if (
      canonical === path.parse(canonical).root || canonical === home ||
      canonical === temporaryRoot
    ) {
      throw new BridgeError(
        "UNSAFE_GATEWAY_STATE_DIRECTORY",
        "The gateway state directory must be a dedicated private leaf.",
      );
    }
    let existed = true;
    try {
      const info = await lstat(canonical);
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new BridgeError(
          "UNSAFE_GATEWAY_STATE_DIRECTORY",
          "The gateway state path must be a real directory.",
        );
      }
      this.assertOwnedPrivate(info.uid, info.mode, "directory");
    } catch (error) {
      if (isErrno(error, "ENOENT")) existed = false;
      else throw error;
    }
    if (!existed) {
      await mkdir(canonical, { recursive: true, mode: 0o700 });
      await chmod(canonical, 0o700);
    }
    const root = await realpath(canonical);
    if (root !== canonical) {
      throw new BridgeError(
        "UNSAFE_GATEWAY_STATE_DIRECTORY",
        "The gateway state path changed while it was prepared.",
      );
    }
    const markerPath = path.join(root, STATE_MARKER);
    let markerExists = true;
    try {
      await this.readPrivateFile(markerPath, MAX_MARKER_FILE_BYTES, STATE_MARKER_CONTENT);
    } catch (error) {
      if (isErrno(error, "ENOENT")) markerExists = false;
      else throw error;
    }
    if (!markerExists) {
      const entries = await readdir(root);
      if (existed && entries.some((entry) => entry !== "nodes.json")) {
        throw new BridgeError(
          "GATEWAY_STATE_DIRECTORY_NOT_OWNED",
          "The existing state directory is non-empty and lacks the ownership marker.",
        );
      }
      const marker = await open(
        markerPath,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY |
          (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
      try {
        await marker.writeFile(STATE_MARKER_CONTENT, "utf8");
        await marker.sync();
      } finally {
        await marker.close();
      }
    }
    return root;
  }

  private async readPrivateFile(
    filePath: string,
    maximumBytes: number,
    expectedBody?: string,
  ): Promise<string> {
    const info = await lstat(filePath);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new BridgeError(
        "UNSAFE_GATEWAY_STATE_FILE",
        "A gateway controller file is not a regular file.",
      );
    }
    this.assertOwnedPrivate(info.uid, info.mode, "file");
    if (info.size > maximumBytes) {
      throw new BridgeError(
        "GATEWAY_STATE_FILE_TOO_LARGE",
        "A gateway controller file exceeds its strict byte limit.",
      );
    }
    const handle = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const opened = await handle.stat();
      if (
        !opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino ||
        opened.size > maximumBytes
      ) {
        throw new BridgeError(
          "UNSAFE_GATEWAY_STATE_FILE",
          "A gateway controller file changed during its bounded read.",
        );
      }
      this.assertOwnedPrivate(opened.uid, opened.mode, "file");
      const buffer = Buffer.alloc(maximumBytes + 1);
      let offset = 0;
      while (offset < buffer.length) {
        const read = await handle.read(buffer, offset, buffer.length - offset, offset);
        if (read.bytesRead === 0) break;
        offset += read.bytesRead;
      }
      if (offset > maximumBytes) {
        throw new BridgeError(
          "GATEWAY_STATE_FILE_TOO_LARGE",
          "A gateway controller file exceeds its strict byte limit.",
        );
      }
      const body = buffer.subarray(0, offset).toString("utf8");
      if (expectedBody !== undefined && body !== expectedBody) {
        throw new BridgeError(
          "GATEWAY_STATE_DIRECTORY_NOT_OWNED",
          "The gateway ownership marker is not recognized.",
        );
      }
      return body;
    } finally {
      await handle.close();
    }
  }

  private async loadStateFile(): Promise<T | undefined> {
    let body: string;
    try {
      body = await this.readPrivateFile(this.stateFilePath, this.codec.maximumBytes);
    } catch (error) {
      if (isErrno(error, "ENOENT")) return undefined;
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new BridgeError(
        "CORRUPT_GATEWAY_STATE",
        "The gateway controller state is not valid JSON.",
      );
    }
    if (
      isObject(parsed) && Object.hasOwn(parsed, "schemaVersion") &&
      parsed.schemaVersion !== this.codec.schemaVersion
    ) {
      throw new BridgeError(
        "GATEWAY_STATE_SCHEMA_UNSUPPORTED",
        "The gateway state schema is unsupported. Stop Embassy, move gateway-state.json aside, then restart.",
      );
    }
    const decoded = this.codec.decode(parsed);
    if (decoded === undefined) {
      throw new BridgeError(
        "CORRUPT_GATEWAY_STATE",
        "The gateway controller state failed strict schema validation.",
      );
    }
    this.codec.assertBounds?.(decoded);
    return decoded;
  }

  private async persist(next: T, prior: T | undefined): Promise<void> {
    const temporary = path.join(this.rootDir, `.gateway-state-${randomUUID()}.tmp`);
    const body = `${JSON.stringify(next, null, 2)}\n`;
    if (Buffer.byteLength(body, "utf8") > this.codec.maximumBytes) {
      throw new BridgeError(
        "GATEWAY_STATE_FILE_TOO_LARGE",
        "The bounded gateway state exceeds its durable byte limit.",
      );
    }
    const observedPrior = await this.loadStateFile();
    if (!sameCommit(observedPrior, prior)) {
      this.poisoned = true;
      this.state = undefined;
      throw new PostRenamePersistenceError();
    }
    let handle: FileHandle | undefined;
    let renameAttempted = false;
    try {
      try {
        handle = await open(
          temporary,
          constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY |
            (constants.O_NOFOLLOW ?? 0),
          0o600,
        );
        await handle.writeFile(body, "utf8");
        await handle.chmod(0o600);
        await handle.sync();
        await handle.close();
        handle = undefined;
        try {
          const existing = await lstat(this.stateFilePath);
          if (existing.isSymbolicLink() || !existing.isFile()) {
            throw new BridgeError(
              "UNSAFE_GATEWAY_STATE_FILE",
              "The gateway state target is not a regular file.",
            );
          }
          this.assertOwnedPrivate(existing.uid, existing.mode, "file");
        } catch (error) {
          if (!isErrno(error, "ENOENT")) throw error;
        }
        renameAttempted = true;
        await this.renameStateFile(temporary, this.stateFilePath);
        await this.afterStateFileRename?.();
        const directory = await open(this.rootDir, constants.O_RDONLY);
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      } catch (error) {
        if (!renameAttempted) throw error;
        let installed: T | undefined;
        let readbackFailed = false;
        try {
          installed = await this.loadStateFile();
        } catch {
          readbackFailed = true;
        }
        if (sameCommit(installed, next)) return;
        if (!readbackFailed && sameCommit(installed, prior)) throw error;
        this.poisoned = true;
        this.state = undefined;
        throw new PostRenamePersistenceError();
      }
    } finally {
      await handle?.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
    }
  }
}
