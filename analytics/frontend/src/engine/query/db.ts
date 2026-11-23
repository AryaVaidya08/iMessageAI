// Minimal storage interface used by the query worker. Unit 1's storage layer
// should satisfy this (or be adapted to it in openDb.ts).
export type SqlValue = string | number | null | Uint8Array;
export type Row = Record<string, SqlValue>;

export interface QueryDb {
  /** Run a statement and return all rows as objects. */
  all(sql: string, bind?: SqlValue[] | Record<string, SqlValue>): Promise<Row[]>;
  /** First row or undefined. */
  get(sql: string, bind?: SqlValue[] | Record<string, SqlValue>): Promise<Row | undefined>;
  /** Run a statement that returns no rows (writes). */
  run(sql: string, bind?: SqlValue[] | Record<string, SqlValue>): Promise<void>;
}
