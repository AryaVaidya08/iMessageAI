// Runs the REAL engine in Node for parity tests:
//   chat.db (+ .abcddb files) --openChatDb/ChatDbExtractor--> runIngest --AppWriter--> better-sqlite3 app DB
//   request(method, path, body) --resolveRoute/dispatch--> the same route handlers the browser worker uses.
// Only the storage backend differs from the browser (better-sqlite3 here, wa-sqlite + IndexedDB there).
import { createRequire } from "node:module";
import { fstatSync, openSync, readFileSync, readSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { migrate } from "../../src/engine/schema";
import { runIngest } from "../../src/engine/ingest/orchestrator";
import { createRealDeps, type AppDbLike } from "../../src/engine/ingest/deps";
import { openChatDb, type SyncReader } from "../../src/engine/ingest/fileVfs";
import { adaptAppDb } from "../../src/engine/query/openDb";
import { dispatch, resolveRoute, RouteError } from "../../src/engine/query/router";
import "../../src/engine/query/routes";
import type { EngineInit, ParityEngine } from "./engine";
import type { IngestEvent } from "../../src/engine/protocol";

const require_ = createRequire(import.meta.url);
const wasmBinary = readFileSync(require_.resolve("wa-sqlite/dist/wa-sqlite.wasm"));

export function fileReader(path: string): SyncReader {
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

function bytesReader(bytes: Uint8Array): SyncReader {
  return { size: bytes.length, read: (o, l) => bytes.subarray(o, Math.min(bytes.length, o + l)) };
}

function findAbcddb(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.abcddb$/i.test(e)) out.push(p);
    }
  };
  try {
    walk(dir);
  } catch {
    /* no address book fixtures */
  }
  return out.sort();
}

/** better-sqlite3 behind the same interface as the browser's AppDb. */
export function nodeAppDb(): AppDbLike & { raw: Database.Database } {
  const raw = new Database(":memory:");
  raw.pragma("foreign_keys = ON");
  const bind = (p: unknown[] = []) => p.map((v) => (v === undefined ? null : typeof v === "boolean" ? +v : v));
  return {
    raw,
    all: async (sql: string, params?: unknown[]) => {
      const st = raw.prepare(sql);
      return (st.reader ? st.all(...bind(params)) : (st.run(...bind(params)), [])) as never;
    },
    run: async (sql: string, params?: unknown[]) => {
      raw.prepare(sql).run(...bind(params));
    },
    runMany: async (sql: string, rows: unknown[][]) => {
      const st = raw.prepare(sql);
      for (const r of rows) st.run(...bind(r));
    },
    exec: async (sql: string) => {
      raw.exec(sql);
    },
    close: async () => raw.close(),
  } as never;
}

export async function ingestInto(
  app: AppDbLike,
  init: { chatDbPath: string; addressBookDir?: string; extraFiles?: Record<string, string> },
  emit: (e: IngestEvent) => void = () => {},
): Promise<IngestEvent[]> {
  const events: IngestEvent[] = [];
  const abFiles = init.addressBookDir ? findAbcddb(init.addressBookDir) : [];
  const readers = new Map<string, SyncReader>();
  const files = {
    chatDb: new File([], "chat.db"),
    addressBooks: abFiles.map((p, i) => {
      const f = new File([], `${i}-${p.split("/").pop()}`);
      readers.set(f.name, bytesReader(new Uint8Array(readFileSync(p))));
      return f;
    }),
  };
  const deps = await createRealDeps(files, {
    app,
    openChat: (f, o) => {
      const reader = f === files.chatDb ? fileReader(init.chatDbPath) : readers.get((f as File).name)!;
      return openChatDb(f, { ...o, reader, wasmBinary, wasmUrl: "node-test" });
    },
  });
  try {
    await runIngest({
      deps,
      files,
      signal: new AbortController().signal,
      emit: (e) => {
        events.push(e);
        emit(e);
      },
    });
  } finally {
    deps.dispose();
    await deps.reader.close();
  }
  return events;
}

export async function createParityEngine(init: EngineInit): Promise<ParityEngine> {
  const app = nodeAppDb();
  await migrate({
    exec: (s) => void app.raw.exec(s),
    getUserVersion: () => app.raw.pragma("user_version", { simple: true }) as number,
    setUserVersion: (v) => void app.raw.pragma(`user_version = ${v}`),
  });
  const events = await ingestInto(app, init);
  const err = events.find((e) => e.type === "error");
  if (err && err.type === "error") throw new Error(`ingest failed: ${err.message}`);

  const q = adaptAppDb(app);
  return {
    async request(method, path, body) {
      const r = resolveRoute(method, path, body as Record<string, unknown> | undefined);
      if (!r) return { status: 404, body: { detail: "Not Found" } };
      try {
        return { status: 200, body: JSON.parse(JSON.stringify(await dispatch(async () => q, r.route, r.params))) };
      } catch (e) {
        if (e instanceof RouteError) return { status: e.status, body: { detail: e.detail } };
        throw e;
      }
    },
    close: () => app.close(),
  };
}
