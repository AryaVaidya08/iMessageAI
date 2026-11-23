// wa-sqlite (ASYNC build) + IDBBatchAtomicVFS (IndexedDB). Unlike AccessHandlePoolVFS this lets several
// workers hold the DB open at once: the ingest worker writes while the query worker reads. Connections
// are serialized by Web Locks (each waits for its turn instead of failing), so a reader stalls only for
// the length of one ingest batch commit, and ingest stalls only while a query runs.
//
// The async (Asyncify) build cannot handle overlapping calls on one module instance, so every AppDb call
// goes through a per-connection mutex.
import * as SQLite from "wa-sqlite";
import SQLiteAsyncESMFactory from "wa-sqlite/dist/wa-sqlite-async.mjs";
import { IDBBatchAtomicVFS } from "wa-sqlite/src/examples/IDBBatchAtomicVFS.js";
import wasmUrl from "wa-sqlite/dist/wa-sqlite-async.wasm?url";
import { migrate } from "../schema";
import type { Queryable, SqlValue } from "./helpers";
import { IDB_NAME, markSaved } from "./marker";

const DB_FILE = "app.db";

type SQLiteAPI = ReturnType<typeof SQLite.Factory>;

// Diagnostics: build with VITE_TRACE=1 to log every DB call per worker (start/end) to the console.
const TRACE = import.meta.env.VITE_TRACE === "1";
let traceSeq = 0;
function traced<T>(label: string, sql: string, fn: () => Promise<T>): Promise<T> {
  if (!TRACE) return fn();
  const id = ++traceSeq;
  const who = (globalThis as { name?: string }).name || "main";
  const t0 = performance.now();
  console.log(`[trace ${who}] #${id} start ${label} ${sql.replace(/\s+/g, " ").slice(0, 90)}`);
  return fn().then(
    (r) => (console.log(`[trace ${who}] #${id} end ${Math.round(performance.now() - t0)}ms ${label} ${sql.replace(/\s+/g, " ").slice(0, 70)}`), r),
    (e) => (console.log(`[trace ${who}] #${id} FAIL ${e}`), Promise.reject(e)),
  );
}

class Mutex {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn);
    this.tail = next.catch(() => {});
    return next;
  }
}

export class AppDb implements Queryable {
  private mutex = new Mutex();
  constructor(
    private sqlite3: SQLiteAPI,
    private db: number,
    private vfs: IDBBatchAtomicVFS,
  ) {}

  exec(sql: string): Promise<void> {
    return traced("exec", sql, () => this.mutex.run(async () => {
      await this.sqlite3.exec(this.db, sql);
    }));
  }

  async run(sql: string, params: SqlValue[] = []): Promise<void> {
    await this.all(sql, params);
  }

  /** Executes one prepared statement for many parameter rows (caller owns the transaction). */
  runMany(sql: string, rows: SqlValue[][]): Promise<void> {
    return traced("runMany", sql, () => this.mutex.run(async () => {
      for await (const stmt of this.sqlite3.statements(this.db, sql)) {
        for (const params of rows) {
          this.sqlite3.reset(stmt);
          this.sqlite3.bind_collection(stmt, params as never);
          while ((await this.sqlite3.step(stmt)) === SQLite.SQLITE_ROW) { /* drain */ }
        }
        break; // single statement only
      }
    }));
  }

  all<T = Record<string, SqlValue>>(sql: string, params: SqlValue[] = []): Promise<T[]> {
    return traced("all", sql, () => this.mutex.run(async () => {
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
    }));
  }

  async close(): Promise<void> {
    await this.mutex.run(async () => {
      try {
        await this.sqlite3.close(this.db);
      } finally {
        await this.vfs.close();
      }
    });
  }
}

/** Opens (creating if needed) and migrates the app DB. Safe to call from several workers. */
export async function openAppDb(opts: { durability?: "default" | "strict" | "relaxed" } = {}): Promise<AppDb> {
  let vfs: IDBBatchAtomicVFS | undefined;
  try {
    const module = await SQLiteAsyncESMFactory({ locateFile: () => wasmUrl });
    const sqlite3 = SQLite.Factory(module as never);
    vfs = new IDBBatchAtomicVFS(IDB_NAME, { durability: opts.durability ?? "default" });
    sqlite3.vfs_register(vfs as never, true);
    const handle = await sqlite3.open_v2(DB_FILE);
    const app = new AppDb(sqlite3, handle, vfs);
    try {
      // 16 KB pages (only effective when the file is created): 4x fewer IndexedDB records than the 4 KB default.
      await app.exec("PRAGMA page_size = 16384;");
      await app.exec("PRAGMA foreign_keys = ON; PRAGMA synchronous = NORMAL; PRAGMA cache_size = -16384;");
      await migrate({
        exec: (s) => app.exec(s),
        getUserVersion: async () => Number((await app.all<{ user_version: number }>("PRAGMA user_version"))[0].user_version),
        setUserVersion: (v) => app.exec(`PRAGMA user_version = ${v | 0}`),
      });
      await markSaved();
    } catch (e) {
      await app.close();
      throw e;
    }
    return app;
  } catch (e) {
    try { await vfs?.close(); } catch { /* ignore */ }
    throw e;
  }
}

export { hasSavedDb, clearAllData } from "./marker";
