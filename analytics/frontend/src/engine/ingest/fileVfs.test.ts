import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, openSync, readSync, fstatSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { openChatDb, ChatDbError, CHUNK_BYTES, type SyncReader } from "./fileVfs";

const require_ = createRequire(import.meta.url);
const wasmBinary = readFileSync(require_.resolve("wa-sqlite/dist/wa-sqlite.wasm"));
const wasmUrl = "node-test";

function nodeReader(path: string): SyncReader {
  const fd = openSync(path, "r");
  const size = fstatSync(fd).size;
  return {
    size,
    read(offset, length) {
      const buf = new Uint8Array(Math.max(0, Math.min(length, size - offset)));
      if (buf.length) readSync(fd, buf, 0, buf.length, offset);
      return buf;
    },
  };
}
const open = (path: string, extra = {}) => openChatDb(new Blob([]), { reader: nodeReader(path), wasmUrl, wasmBinary, ...extra });

const dir = mkdtempSync(join(tmpdir(), "fvfs-"));
const py = (code: string, ...args: string[]) => execFileSync("python3", ["-I", "-c", code, ...args]);

beforeAll(() => {
  py(
    `import sqlite3,sys
c=sqlite3.connect(sys.argv[1]+'/small.db'); c.execute('create table message(ROWID integer primary key, text text, date integer)')
c.executemany('insert into message values(?,?,?)',[(i,'hello %d'%i,700000000000000000+i) for i in range(1,501)]); c.commit(); c.close()
c=sqlite3.connect(sys.argv[1]+'/wal.db'); c.execute('pragma journal_mode=wal'); c.execute('create table t(x)'); c.executemany('insert into t values(?)',[(i,) for i in range(10)]); c.commit(); c.close()`,
    dir,
  );
});

describe("openChatDb", () => {
  it("queries a small db, incl. 64-bit ints and params", async () => {
    const db = await open(join(dir, "small.db"));
    expect(db.info.walMode).toBe(false);
    const r = await db.query("SELECT count(*) AS n, max(date) AS d FROM message");
    expect(r[0].n).toBe(500);
    expect(Number(r[0].d)).toBe(700000000000000500);
    const one = await db.query("SELECT text FROM message WHERE ROWID=?", [42]);
    expect(one[0].text).toBe("hello 42");
    expect(await db.tableExists("message")).toBe(true);
    expect(await db.tableExists("nope")).toBe(false);
    await expect(db.query("SELECT * FROM nope")).rejects.toThrow(/no such table/);
    // read-only
    await expect(db.query("DELETE FROM message")).rejects.toThrow();
    await db.close();
  });

  it("streams rows with early stop", async () => {
    const db = await open(join(dir, "small.db"));
    let n = 0;
    await db.each("SELECT ROWID FROM message ORDER BY ROWID", undefined, () => (++n < 10 ? true : false));
    expect(n).toBe(10);
    await db.close();
  });

  it("reads a WAL-mode db (checkpointed data only) in rollback mode", async () => {
    const db = await open(join(dir, "wal.db"));
    expect(db.info.walMode).toBe(true);
    expect((await db.query("SELECT count(*) AS n FROM t"))[0].n).toBe(10);
    await db.close();
  });

  it("rejects non-SQLite, empty, encrypted-looking and truncated files", async () => {
    writeFileSync(join(dir, "text.db"), "just some text, definitely not a database ".repeat(50));
    writeFileSync(join(dir, "empty.db"), "");
    const rnd = new Uint8Array(8192).map((_, i) => (i * 131 + 7) % 256 | 0x80);
    writeFileSync(join(dir, "enc.db"), rnd);
    const code = (p: string) => open(join(dir, p)).then(() => "ok", (e: ChatDbError) => e.code);
    expect(await code("text.db")).toBe("not-sqlite");
    expect(await code("empty.db")).toBe("empty");
    expect(await code("enc.db")).toBe("encrypted");
    py(
      `import sys
d=open(sys.argv[1]+'/small.db','rb').read(); open(sys.argv[1]+'/trunc.db','wb').write(d[:2000])
b=bytearray(d); b[16]=0;b[17]=3; open(sys.argv[1]+'/badpage.db','wb').write(bytes(b))
b=bytearray(d); b[4096:8192]=b'\\xff'*4096; open(sys.argv[1]+'/damaged.db','wb').write(bytes(b))`,
      dir,
    );
    expect(await code("trunc.db")).toBe("corrupt");
    expect(await code("badpage.db")).toBe("corrupt");
    // damaged interior pages surface as a friendly error on query, not a crash
    const db = await open(join(dir, "damaged.db")).catch((e) => e);
    if (db instanceof Error) expect(db).toBeInstanceOf(ChatDbError);
    else await expect(db.query("SELECT sum(length(text)) FROM message")).rejects.toThrow();
  });

  it("keeps the page cache and heap bounded on a >100MB db", async () => {
    py(
      `import sqlite3,sys
c=sqlite3.connect(sys.argv[1]+'/big.db'); c.execute('create table message(ROWID integer primary key, text text)')
blob='x'*1000
for b in range(130): c.executemany('insert into message(text) values(?)',[(blob+str(i),) for i in range(1000)]); c.commit()
c.close()`,
      dir,
    );
    const reader = nodeReader(join(dir, "big.db"));
    expect(reader.size).toBeGreaterThan(100e6);
    const db = await openChatDb(new Blob([]), { reader, wasmUrl, wasmBinary, cacheBytes: 8 * 1024 * 1024 });
    (globalThis as any).gc?.();
    const base = process.memoryUsage();
    let peak = 0;
    // full table scan twice => touches ~260MB of reads through an 8MB cache
    for (let pass = 0; pass < 2; pass++) {
      let n = 0;
      await db.each("SELECT length(text) AS l FROM message", undefined, () => {
        if (++n % 20000 === 0) peak = Math.max(peak, process.memoryUsage().arrayBuffers + process.memoryUsage().heapUsed);
      });
      expect(n).toBe(130000);
    }
    const st = db.stats();
    expect(st.cachedChunks * CHUNK_BYTES).toBeLessThanOrEqual(8 * 1024 * 1024);
    expect(st.bytesFetched).toBeGreaterThan(200e6); // cache really was evicting
    const growth = (peak - base.arrayBuffers - base.heapUsed) / 1e6;
    console.log(`file=${(reader.size / 1e6).toFixed(0)}MB fetched=${(st.bytesFetched / 1e6).toFixed(0)}MB growth=${growth.toFixed(1)}MB`);
    expect(growth).toBeLessThan(60);
    await db.close();
  }, 120_000);
});

describe("chat.db-wal replay", () => {
  beforeAll(() => {
    // Keep the writer open with checkpointing off, then copy db + wal mid-flight (what a user's copy looks like).
    py(
      `import sqlite3,sys,shutil
d=sys.argv[1]
c=sqlite3.connect(d+'/live.db'); c.execute('pragma journal_mode=wal'); c.execute('pragma wal_autocheckpoint=0')
c.execute('create table t(x integer primary key, y text)'); c.commit()
c.executemany('insert into t values(?,?)',[(i,'row %d'%i) for i in range(1,3001)]); c.commit()
c.executemany('insert into t values(?,?)',[(i,'late %d'%i) for i in range(3001,3101)]); c.commit()
shutil.copy(d+'/live.db',d+'/copy.db'); shutil.copy(d+'/live.db-wal',d+'/copy.db-wal')
c.close()`,
      dir,
    );
  });

  it("without the -wal the recent data is missing", async () => {
    const db = await open(join(dir, "copy.db"));
    expect(db.info.walMode).toBe(true);
    await expect(db.query("SELECT count(*) AS n FROM t")).rejects.toThrow();
    await db.close();
  });

  it("applies committed WAL frames when the -wal is supplied", async () => {
    const db = await open(join(dir, "copy.db"), { walReader: nodeReader(join(dir, "copy.db-wal")) });
    expect(db.info.walFramesApplied).toBeGreaterThan(0);
    const r = await db.query("SELECT count(*) AS n, max(x) AS mx FROM t");
    expect(r[0].n).toBe(3100);
    expect(r[0].mx).toBe(3100);
    expect((await db.query("SELECT y FROM t WHERE x=3050"))[0].y).toBe("late 3050");
    await db.close();
  });

  it("ignores a torn trailing frame", async () => {
    const wal = readFileSync(join(dir, "copy.db-wal"));
    const cut = join(dir, "torn.db-wal");
    writeFileSync(cut, wal.subarray(0, wal.length - 100)); // truncated final frame => last commit invalid
    const db = await open(join(dir, "copy.db"), { walReader: nodeReader(cut) });
    const r = await db.query("SELECT count(*) AS n FROM t");
    expect(r[0].n).toBe(3000); // the last transaction (100 rows) is dropped, the earlier one still counts
    await db.close();
  });
});
