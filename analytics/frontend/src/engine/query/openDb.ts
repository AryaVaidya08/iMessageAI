import { openAppDb as openStorage } from "../storage/db";
import type { AppDbLike } from "../ingest/deps";
import type { QueryDb, Row, SqlValue } from "./db";

type Bind = SqlValue[] | Record<string, SqlValue> | unknown[] | undefined;

function toArray(bind: Bind): SqlValue[] {
  if (!bind) return [];
  if (!Array.isArray(bind)) throw new Error("named bind parameters are not supported");
  return (bind as unknown[]).map((v) => (v === undefined ? null : typeof v === "boolean" ? (v ? 1 : 0) : (v as SqlValue)));
}

/** QueryDb over the app DB (superset: also get, exec and close, which some route modules use). */
export function adaptAppDb(app: AppDbLike): QueryDb & {
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
} {
  return {
    all: (sql, bind) => app.all(sql, toArray(bind)) as Promise<Row[]>,
    get: async (sql, bind) => ((await app.all(sql, toArray(bind))) as Row[])[0],
    // unit 10 reads `.changes` after UPDATEs
    run: async (sql, bind) => {
      await app.run(sql, toArray(bind));
      const r = await app.all<{ n: number }>("SELECT changes() AS n");
      return { changes: Number(r[0]?.n ?? 0) } as never;
    },
    exec: (sql) => app.exec(sql),
    close: () => app.close(),
  };
}

/** Opens the app DB in the query worker (readers share it with the ingest worker; see storage/db.ts). */
export async function openAppDb(): Promise<QueryDb> {
  return adaptAppDb(await openStorage());
}
