/**
 * Read-only SQLite access to a user-uploaded database (chat.db, AddressBook
 * .abcddb) WITHOUT loading it into memory.
 *
 * A wa-sqlite VFS serves xRead from `File.slice` (via FileReaderSync, which is
 * only available inside a Web Worker) through a small LRU chunk cache, so heap
 * use stays bounded by CACHE_BYTES regardless of file size.
 *
 * MUST run in a worker (FileReaderSync). Tests inject a Node reader instead.
 *
 * WAL behaviour: chat.db is normally in WAL mode, and the "-wal" sidecar is
 * usually NOT uploaded. We cannot create WAL/shm files for a read-only File, so
 * the VFS patches the header of page 1 (bytes 18/19, file-format versions) to
 * present the database as rollback-journal mode. Consequence: only data already
 * checkpointed into the main file is visible; messages still sitting in an
 * un-uploaded chat.db-wal are missed. `info.walMode` reports when the original
 * file was WAL so the UI can warn the user (e.g. quit Messages, or copy the
 * -wal file too, before uploading).
 */
import SQLiteESMFactory from "wa-sqlite/dist/wa-sqlite.mjs";
import wasmUrl from "wa-sqlite/dist/wa-sqlite.wasm?url";
import * as SQLite from "wa-sqlite";
import * as VFS from "wa-sqlite/src/VFS.js";

export const CHUNK_BYTES = 64 * 1024;
export const CACHE_BYTES = 32 * 1024 * 1024;
const SQLITE_MAGIC = "SQLite format 3\0";

export type ChatDbErrorCode = "not-sqlite" | "encrypted" | "corrupt" | "empty" | "unsupported";

export class ChatDbError extends Error {
  constructor(public code: ChatDbErrorCode, message: string) {
    super(message);
    this.name = "ChatDbError";
  }
}

/** Synchronous random-access reader. Reads past EOF return a short array. */
export interface SyncReader {
  readonly size: number;
  read(offset: number, length: number): Uint8Array;
}

export function fileReaderSync(file: Blob): SyncReader {
  const frs = new (globalThis as any).FileReaderSync() as {
    readAsArrayBuffer(b: Blob): ArrayBuffer;
  };
  return {
    size: file.size,
    read(offset, length) {
      return new Uint8Array(frs.readAsArrayBuffer(file.slice(offset, offset + length)));
    },
  };
}

export interface DbInfo {
  pageSize: number;
  walMode: boolean;
  fileSize: number;
}

/** Random-looking, non-text first bytes with no SQLite magic => likely encrypted. */
function looksEncrypted(head: Uint8Array): boolean {
  if (head.length < 16) return false;
  let printable = 0;
  for (let i = 0; i < 16; i++) if (head[i] >= 0x20 && head[i] < 0x7f) printable++;
  return printable < 8;
}

/** Validate the header and return friendly errors for non-SQLite input. */
export function inspectHeader(head: Uint8Array, fileSize: number): DbInfo {
  if (fileSize === 0) throw new ChatDbError("empty", "This file is empty.");
  const magic = String.fromCharCode(...head.subarray(0, 16));
  if (head.length < 100 || magic !== SQLITE_MAGIC) {
    if (looksEncrypted(head)) {
      throw new ChatDbError(
        "encrypted",
        "This database looks encrypted and cannot be read. Use the unencrypted chat.db from ~/Library/Messages.",
      );
    }
    throw new ChatDbError(
      "not-sqlite",
      "This is not a SQLite database. Choose chat.db (Messages) or an AddressBook-v22.abcddb file.",
    );
  }
  const raw = (head[16] << 8) | head[17];
  const pageSize = raw === 1 ? 65536 : raw;
  if (pageSize < 512 || (pageSize & (pageSize - 1)) !== 0) {
    throw new ChatDbError("corrupt", "The database header is corrupt (invalid page size).");
  }
  if (fileSize < pageSize) {
    throw new ChatDbError("corrupt", "The database file is truncated (smaller than one page).");
  }
  return { pageSize, walMode: head[18] === 2 || head[19] === 2, fileSize };
}

class LruChunks {
  private map = new Map<number, Uint8Array>();
  constructor(private maxChunks: number) {}
  get(k: number) {
    const v = this.map.get(k);
    if (v) {
      this.map.delete(k);
      this.map.set(k, v);
    }
    return v;
  }
  set(k: number, v: Uint8Array) {
    this.map.set(k, v);
    if (this.map.size > this.maxChunks) this.map.delete(this.map.keys().next().value as number);
  }
  get size() {
    return this.map.size;
  }
  clear() {
    this.map.clear();
  }
}

/** Read-only VFS exposing one file under `dbName`. */
export class FileVFS extends (VFS.Base as new () => any) {
  name: string;
  private cache: LruChunks;
  reads = 0;
  bytesFetched = 0;

  constructor(
    name: string,
    private dbName: string,
    private reader: SyncReader,
    private patchWal: boolean,
    cacheBytes = CACHE_BYTES,
  ) {
    super();
    this.name = name;
    this.cache = new LruChunks(Math.max(4, Math.floor(cacheBytes / CHUNK_BYTES)));
  }

  /** Drop cached pages and the reader so the File can be released. */
  release() {
    this.cache.clear();
    this.reader = { size: this.reader.size, read: () => new Uint8Array(0) };
  }

  get cachedChunks() {
    return this.cache.size;
  }

  private chunk(idx: number): Uint8Array {
    let c = this.cache.get(idx);
    if (!c) {
      c = this.reader.read(idx * CHUNK_BYTES, CHUNK_BYTES);
      this.bytesFetched += c.length;
      this.cache.set(idx, c);
    }
    return c;
  }

  xOpen(name: string | null, _fileId: number, _flags: number, pOutFlags: DataView) {
    if (name !== this.dbName) return VFS.SQLITE_CANTOPEN; // no journal/wal/temp files
    pOutFlags.setInt32(0, VFS.SQLITE_OPEN_READONLY, true);
    return VFS.SQLITE_OK;
  }
  xClose() {
    return VFS.SQLITE_OK;
  }
  xRead(_fileId: number, pData: Uint8Array, iOffset: number) {
    const want = pData.byteLength;
    const end = Math.min(iOffset + want, this.reader.size);
    let pos = iOffset;
    this.reads++;
    while (pos < end) {
      const ci = Math.floor(pos / CHUNK_BYTES);
      const c = this.chunk(ci);
      const within = pos - ci * CHUNK_BYTES;
      const n = Math.min(c.length - within, end - pos);
      if (n <= 0) break;
      pData.set(c.subarray(within, within + n), pos - iOffset);
      pos += n;
    }
    // Present a WAL-mode db as rollback-journal mode (see header comment).
    if (this.patchWal && iOffset <= 19 && iOffset + want > 18 && pos > 19) {
      for (const b of [18, 19]) if (pData[b - iOffset] === 2) pData[b - iOffset] = 1;
    }
    const got = pos - iOffset;
    if (got < want) {
      pData.fill(0, Math.max(got, 0));
      return VFS.SQLITE_IOERR_SHORT_READ;
    }
    return VFS.SQLITE_OK;
  }
  xWrite() {
    return VFS.SQLITE_READONLY;
  }
  xTruncate() {
    return VFS.SQLITE_READONLY;
  }
  xSync() {
    return VFS.SQLITE_OK;
  }
  xFileSize(_id: number, pSize64: DataView) {
    pSize64.setBigInt64(0, BigInt(this.reader.size), true);
    return VFS.SQLITE_OK;
  }
  xLock() {
    return VFS.SQLITE_OK;
  }
  xUnlock() {
    return VFS.SQLITE_OK;
  }
  xCheckReservedLock(_id: number, pResOut: DataView) {
    pResOut.setInt32(0, 0, true);
    return VFS.SQLITE_OK;
  }
  xFileControl() {
    return VFS.SQLITE_NOTFOUND;
  }
  xDeviceCharacteristics() {
    return VFS.SQLITE_IOCAP_IMMUTABLE;
  }
  xDelete() {
    return VFS.SQLITE_OK;
  }
  xAccess(name: string, _flags: number, pResOut: DataView) {
    pResOut.setInt32(0, name === this.dbName ? 1 : 0, true); // no -journal / -wal
    return VFS.SQLITE_OK;
  }
}

export type SqlValue = number | bigint | string | Uint8Array | null;
export type Row = Record<string, SqlValue>;
export type Params = SqlValue[] | Record<string, SqlValue>;

export interface OpenOptions {
  /** Override wasm location (tests / non-Vite hosts). */
  wasmUrl?: string;
  /** Pre-fetched wasm bytes (Node tests, where fetch(file://) is unavailable). */
  wasmBinary?: ArrayBuffer | Uint8Array;
  /** Inject a reader (tests). Defaults to FileReaderSync over the File. */
  reader?: SyncReader;
  cacheBytes?: number;
  /** The chat.db-wal copied next to chat.db: committed frames are overlaid on the database pages. */
  walFile?: Blob;
}

export interface ChatDbHandle {
  readonly info: DbInfo;
  /** Run a query and return all rows as objects. Keep result sets small (LIMIT). */
  query(sql: string, params?: Params): Promise<Row[]>;
  /** Stream rows without materialising the result set. Return false to stop early. */
  each(sql: string, params: Params | undefined, cb: (row: Row) => void | boolean | Promise<void | boolean>): Promise<void>;
  tableExists(name: string): Promise<boolean>;
  stats(): { reads: number; bytesFetched: number; cachedChunks: number };
  close(): Promise<void>;
}

const modules = new Map<string, Promise<any>>();
function getModule(url: string, wasmBinary?: ArrayBuffer | Uint8Array) {
  let p = modules.get(url);
  if (!p) {
    p = SQLiteESMFactory(wasmBinary ? { wasmBinary } : { locateFile: () => url });
    modules.set(url, p);
  }
  return p;
}

let vfsCounter = 0;

/**
 * Open an uploaded SQLite file (chat.db, .abcddb) read-only. Throws ChatDbError
 * with a user-presentable message for non-SQLite / encrypted / corrupt input.
 */
export async function openChatDb(file: Blob, opts: OpenOptions = {}): Promise<ChatDbHandle> {
  const reader = opts.reader ?? fileReaderSync(file);
  const info = inspectHeader(reader.read(0, 100), reader.size);

  const Module = await getModule(opts.wasmUrl ?? wasmUrl, opts.wasmBinary);
  const sqlite3 = SQLite.Factory(Module);
  const dbName = "upload.db";
  const vfs = new FileVFS(`file-vfs-${++vfsCounter}`, dbName, reader, info.walMode, opts.cacheBytes);
  sqlite3.vfs_register(vfs as any, false);

  const db = await sqlite3.open_v2(dbName, SQLite.SQLITE_OPEN_READONLY, vfs.name);

  const each: ChatDbHandle["each"] = async (sql, params, cb) => {
    try {
      for await (const stmt of sqlite3.statements(db, sql)) {
        if (params) sqlite3.bind_collection(stmt, params as any);
        const cols = sqlite3.column_names(stmt);
        while ((await sqlite3.step(stmt)) === SQLite.SQLITE_ROW) {
          const vals = sqlite3.row(stmt);
          const row: Row = {};
          for (let i = 0; i < cols.length; i++) row[cols[i]] = vals[i] as SqlValue;
          if ((await cb(row)) === false) return;
        }
      }
    } catch (e) {
      throw friendly(e);
    }
  };

  // Force a real read of the schema to catch corruption/encryption early.
  try {
    await each("SELECT count(*) FROM sqlite_master", undefined, () => {});
  } catch (e) {
    try { await sqlite3.close(db); } catch { /* ignore */ }
    vfs.release();
    throw e;
  }

  const handle: ChatDbHandle = {
    info,
    async query(sql, params) {
      const out: Row[] = [];
      await each(sql, params, (r) => void out.push(r));
      return out;
    },
    each,
    async tableExists(name) {
      const r = await handle.query("SELECT 1 AS x FROM sqlite_master WHERE type IN ('table','view') AND name=?", [name]);
      return r.length > 0;
    },
    stats: () => ({ reads: vfs.reads, bytesFetched: vfs.bytesFetched, cachedChunks: vfs.cachedChunks }),
    async close() {
      try {
        await sqlite3.close(db);
      } finally {
        vfs.release();
      }
    },
  };
  return handle;
}

function friendly(e: unknown): Error {
  if (e instanceof ChatDbError) return e;
  const msg = String((e as any)?.message ?? e);
  if (/not a database/i.test(msg))
    return new ChatDbError("encrypted", "SQLite could not read this file. It may be encrypted or damaged.");
  if (/malformed|corrupt|disk image/i.test(msg))
    return new ChatDbError("corrupt", "The database appears to be corrupt or incomplete (was the copy interrupted?).");
  if (/unable to open|cantopen/i.test(msg))
    return new ChatDbError(
      "unsupported",
      "Could not open this database. If it is a WAL-mode chat.db, close Messages and re-copy chat.db (and chat.db-wal) before uploading.",
    );
  return e as Error; // ordinary SQL errors (bad query, missing table) pass through
}
