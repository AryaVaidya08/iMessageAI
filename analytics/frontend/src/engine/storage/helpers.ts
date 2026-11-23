// Backend-neutral helpers over a tiny async DB interface (implemented by AppDb).
export type SqlValue = string | number | null | Uint8Array;

export interface Queryable {
  run(sql: string, params?: SqlValue[]): Promise<void>;
  all<T = Record<string, SqlValue>>(sql: string, params?: SqlValue[]): Promise<T[]>;
  /** Optional fast path: one prepared statement, many rows. */
  runMany?(sql: string, rows: SqlValue[][]): Promise<void>;
}

export async function one<T = Record<string, SqlValue>>(db: Queryable, sql: string, params?: SqlValue[]): Promise<T | undefined> {
  return (await db.all<T>(sql, params))[0];
}

/** Runs fn inside BEGIN/COMMIT; rolls back on throw. Not re-entrant. */
export async function transaction<T>(db: Queryable, fn: () => Promise<T>): Promise<T> {
  await db.run("BEGIN");
  try {
    const r = await fn();
    await db.run("COMMIT");
    return r;
  } catch (e) {
    try { await db.run("ROLLBACK"); } catch { /* already rolled back */ }
    throw e;
  }
}

/**
 * Executes `sql` for each row, committing every `batchSize` rows (one transaction per
 * batch) so memory and journal stay bounded.
 */
export async function runBatched(
  db: Queryable,
  sql: string,
  rows: Iterable<SqlValue[]>,
  batchSize = 2000,
  onBatch?: (done: number) => void,
): Promise<number> {
  let done = 0;
  let batch: SqlValue[][] = [];
  const flush = async () => {
    if (!batch.length) return;
    const b = batch;
    batch = [];
    await transaction(db, async () => {
      if (db.runMany) await db.runMany(sql, b);
      else for (const r of b) await db.run(sql, r);
    });
    done += b.length;
    onBatch?.(done);
  };
  for (const r of rows) {
    batch.push(r);
    if (batch.length >= batchSize) await flush();
  }
  await flush();
  return done;
}

export async function getSyncState(db: Queryable, key: string): Promise<string | null> {
  const r = await one<{ value: string | null }>(db, "SELECT value FROM sync_state WHERE key = ?", [key]);
  return r?.value ?? null;
}

export async function setSyncState(db: Queryable, key: string, value: string): Promise<void> {
  await db.run("INSERT INTO sync_state(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [key, value]);
}
