// wa-sqlite (sync build) + AccessHandlePoolVFS on OPFS. Worker-only (needs sync access handles).
// AccessHandlePoolVFS holds exclusive handles, so only ONE worker may have the DB open at a
// time; openAppDb() serializes via a Web Lock. Workers sharing the DB must closeAppDb()
// when idle, or route all SQL through a single worker.
import * as SQLite from "wa-sqlite";
import SQLiteESMFactory from "wa-sqlite/dist/wa-sqlite.mjs";
import { AccessHandlePoolVFS } from "wa-sqlite/src/examples/AccessHandlePoolVFS.js";
import wasmUrl from "wa-sqlite/dist/wa-sqlite.wasm?url";
import { migrate } from "../schema";
import type { Queryable, SqlValue } from "./helpers";

const OPFS_DIR = "/imessage-analytics";
const OPFS_DIR_NAME = "imessage-analytics";
const MARKER = "imessage-analytics.marker";
const DB_FILE = "app.db";
const LOCK_NAME = "imessage-analytics-db";

type SQLiteAPI = ReturnType<typeof SQLite.Factory>;

export class AppDb implements Queryable {
  constructor(
    private sqlite3: SQLiteAPI,
    private db: number,
    private vfs: AccessHandlePoolVFS,
    private releaseLock: () => void,
  ) {}

  async exec(sql: string): Promise<void> {
    await this.sqlite3.exec(this.db, sql);
  }

  async run(sql: string, params: SqlValue[] = []): Promise<void> {
    await this.all(sql, params);
  }

  /** Executes one prepared statement for many parameter rows (caller owns the transaction). */
  async runMany(sql: string, rows: SqlValue[][]): Promise<void> {
    for await (const stmt of this.sqlite3.statements(this.db, sql)) {
      for (const params of rows) {
        this.sqlite3.reset(stmt);
        this.sqlite3.bind_collection(stmt, params as never);
        while ((await this.sqlite3.step(stmt)) === SQLite.SQLITE_ROW) { /* drain */ }
      }
      break; // single statement only
    }
  }

  async all<T = Record<string, SqlValue>>(sql: string, params: SqlValue[] = []): Promise<T[]> {
    const out: T[] = [];
    for await (const stmt of this.sqlite3.statements(this.db, sql)) {
      if (params.length) this.sqlite3.bind_collection(stmt, params as never);
      const cols = this.sqlite3.column_names(stmt);
      while ((await this.sqlite3.step(stmt)) === SQLite.SQLITE_ROW) {
        const row = this.sqlite3.row(stmt);
        const o: Record<string, SqlValue> = {};
        cols.forEach((c, i) => { o[c] = row[i] as SqlValue; });
        out.push(o as T);
      }
    }
    return out;
  }

  async close(): Promise<void> {
    try {
      await this.sqlite3.close(this.db);
    } finally {
      await this.vfs.close();
      this.releaseLock();
    }
  }
}

function acquireLock(wait: boolean): Promise<() => void> {
  if (!navigator.locks) return Promise.resolve(() => {});
  return new Promise((resolve, reject) => {
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    navigator.locks
      .request(LOCK_NAME, { ifAvailable: !wait }, (lock) => {
        if (!lock) { reject(new Error("App DB is open in another worker")); return; }
        resolve(release);
        return held;
      })
      .catch(reject);
  });
}

/** Opens (creating if needed) and migrates the app DB. */
export async function openAppDb(opts: { wait?: boolean } = {}): Promise<AppDb> {
  const release = await acquireLock(opts.wait ?? true);
  let vfs: AccessHandlePoolVFS | undefined;
  try {
    const module = await SQLiteESMFactory({ locateFile: () => wasmUrl });
    const sqlite3 = SQLite.Factory(module as never);
    vfs = new AccessHandlePoolVFS(OPFS_DIR);
    await vfs.isReady;
    sqlite3.vfs_register(vfs as never, true);
    const handle = await sqlite3.open_v2(DB_FILE);
    const app = new AppDb(sqlite3, handle, vfs, release);
    try {
      await app.exec("PRAGMA foreign_keys = ON; PRAGMA synchronous = NORMAL; PRAGMA cache_size = -16384;");
      await migrate({
        exec: (s) => app.exec(s),
        getUserVersion: async () => Number((await app.all<{ user_version: number }>("PRAGMA user_version"))[0].user_version),
        setUserVersion: (v) => app.exec(`PRAGMA user_version = ${v | 0}`),
      });
      const root = await navigator.storage.getDirectory();
      await root.getFileHandle(MARKER, { create: true });
    } catch (e) {
      await app.close();
      throw e;
    }
    return app;
  } catch (e) {
    try { await vfs?.close(); } catch { /* ignore */ }
    release();
    throw e;
  }
}

/** True when a previously-saved DB exists in OPFS (cheap; does not open it). */
export async function hasSavedDb(): Promise<boolean> {
  try {
    const root = await navigator.storage.getDirectory();
    await root.getFileHandle(MARKER);
    return true;
  } catch {
    return false;
  }
}

async function removeIfPresent(root: FileSystemDirectoryHandle, name: string, recursive: boolean) {
  try {
    await root.removeEntry(name, { recursive });
  } catch (e) {
    if ((e as { name?: string })?.name !== "NotFoundError") throw e;
  }
}

/** Deletes all stored data. The DB must be closed in every worker first. */
export async function clearAllData(): Promise<void> {
  const release = await acquireLock(true); // waits for any open DB to close
  try {
    const root = await navigator.storage.getDirectory();
    await removeIfPresent(root, OPFS_DIR_NAME, true);
    await removeIfPresent(root, MARKER, false);
  } finally {
    release();
  }
}
