// wa-sqlite (sync build) + AccessHandlePoolVFS on the Origin Private File System. Worker-only.
//
// OPFS writes go straight to files on disk, so the browser process does not grow with the amount of data
// (IndexedDB did: ~1 GB of process memory per 100 MB imported). AccessHandlePoolVFS gives ONE connection exclusive
// access, so a single engine worker owns the database and serves both ingest and queries (see workers/engine.worker.ts).
import * as SQLite from "wa-sqlite";
import SQLiteESMFactory from "wa-sqlite/dist/wa-sqlite.mjs";
import { AccessHandlePoolVFS } from "wa-sqlite/src/examples/AccessHandlePoolVFS.js";
import wasmUrl from "wa-sqlite/dist/wa-sqlite.wasm?url";
import { migrate } from "../schema";
import type { Queryable, SqlValue } from "./helpers";
import { OPFS_DIR_NAME, markSaved } from "./marker";

const OPFS_DIR = `/${OPFS_DIR_NAME}`;
const DB_FILE = "app.db";

type SQLiteAPI = ReturnType<typeof SQLite.Factory>;

// Diagnostics: build with VITE_TRACE=1 to log every DB call (start/end + duration) to the console.
const TRACE = import.meta.env.VITE_TRACE === "1";
let traceSeq = 0;
function traced<T>(label: string, sql: string, fn: () => Promise<T>): Promise<T> {
  if (!TRACE) return fn();
  const id = ++traceSeq;
  const t0 = performance.now();
  return fn().then((r) => (console.log(`[trace #${id}] ${Math.round(performance.now() - t0)}ms ${label} ${sql.replace(/\s+/g, " ").slice(0, 80)}`), r));
}

/** FIFO async mutex. */
class Mutex {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn);
    this.tail = next.catch(() => {});
    return next;
  }
}

/** Held from BEGIN to COMMIT/ROLLBACK: ingest batches and query-side write transactions never overlap. */
class TxLock {
  private waiters: (() => void)[] = [];
  private held = false;
  async acquire(): Promise<void> {
    if (!this.held) return void (this.held = true);
    await new Promise<void>((r) => this.waiters.push(r));
  }
  release(): void {
    const next = this.waiters.shift();
    if (next) next();
    else this.held = false;
  }
}

let wasmBytes = () => 0;
/** Bytes currently reserved by the SQLite wasm heap(s) in this worker (a real, if partial, memory figure). */
export function sqliteWasmBytes(): number {
  return wasmBytes();
}

export class AppDb implements Queryable {
  private mutex = new Mutex();
  private tx = new TxLock();
  private inTx = false;
  constructor(
    private sqlite3: SQLiteAPI,
    private db: number,
    private vfs: AccessHandlePoolVFS,
  ) {}

  /** BEGIN waits for any other transaction; COMMIT/ROLLBACK release. Plain statements never wait. */
  private async guard<T>(sql: string, fn: () => Promise<T>): Promise<T> {
    const head = sql.trimStart().slice(0, 12).toUpperCase();
    const begin = head.startsWith("BEGIN");
    const end = head.startsWith("COMMIT") || head.startsWith("ROLLBACK") || head.startsWith("END");
    if (begin) {
      await this.tx.acquire();
      this.inTx = true;
    }
    try {
      return await fn();
    } catch (e) {
      if (begin) {
        this.inTx = false;
        this.tx.release();
      }
      throw e;
    } finally {
      if (end && this.inTx) {
        this.inTx = false;
        this.tx.release();
      }
    }
  }

  exec(sql: string): Promise<void> {
    return this.guard(sql, () =>
      traced("exec", sql, () => this.mutex.run(async () => void (await this.sqlite3.exec(this.db, sql)))),
    );
  }

  async run(sql: string, params: SqlValue[] = []): Promise<void> {
    await this.all(sql, params);
  }

  runMany(sql: string, rows: SqlValue[][]): Promise<void> {
    return traced("runMany", sql, () =>
      this.mutex.run(async () => {
        for await (const stmt of this.sqlite3.statements(this.db, sql)) {
          for (const params of rows) {
            this.sqlite3.reset(stmt);
            this.sqlite3.bind_collection(stmt, params as never);
            while ((await this.sqlite3.step(stmt)) === SQLite.SQLITE_ROW) { /* drain */ }
          }
          break; // single statement only
        }
      }),
    );
  }

  all<T = Record<string, SqlValue>>(sql: string, params: SqlValue[] = []): Promise<T[]> {
    return this.guard(sql, () =>
      traced("all", sql, () =>
        this.mutex.run(async () => {
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
        }),
      ),
    );
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

const isBusy = (e: unknown) =>
  /NoModificationAllowed|Access Handles cannot be created|already in use|locked/i.test(`${(e as { name?: string })?.name} ${(e as Error)?.message}`);

/**
 * Opens (creating if needed) and migrates the app DB. Call once per worker. After a page reload the previous page's
 * worker may still hold the exclusive OPFS handles for a moment, so a busy error is retried for up to ~15 s.
 */
export async function openAppDb(): Promise<AppDb> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      return await openAppDbOnce();
    } catch (e) {
      lastErr = e;
      if (!isBusy(e)) throw e;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw lastErr;
}

async function openAppDbOnce(): Promise<AppDb> {
  let vfs: AccessHandlePoolVFS | undefined;
  try {
    const module = (await SQLiteESMFactory({ locateFile: () => wasmUrl })) as { HEAPU8?: Uint8Array; wasmMemory?: { buffer: ArrayBuffer } };
    wasmBytes = () => module.wasmMemory?.buffer.byteLength ?? module.HEAPU8?.byteLength ?? 0;
    const sqlite3 = SQLite.Factory(module as never);
    vfs = new AccessHandlePoolVFS(OPFS_DIR);
    await vfs.isReady;
    sqlite3.vfs_register(vfs as never, true);
    const handle = await sqlite3.open_v2(DB_FILE);
    const app = new AppDb(sqlite3, handle, vfs);
    try {
      // 16 KB pages (only effective when the file is created); modest page cache keeps the wasm heap small.
      await app.exec("PRAGMA page_size = 16384;");
      await app.exec("PRAGMA foreign_keys = ON; PRAGMA synchronous = NORMAL; PRAGMA cache_size = -8192;");
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
