import { RouteError } from "./router";
/**
 * Minimal contracts shared by the conversation-analytics modules. Deliberately tiny so they can be
 * adapted to whichever SQLite binding the query worker ends up using (wa-sqlite in the browser,
 * node:sqlite in tests).
 */

export type Row = Record<string, unknown>;
export type SqlValue = string | number | bigint | null | Uint8Array;

export interface QueryDb {
  /** Run a SELECT (or any row-returning statement) and return every row as a plain object. */
  all<T = Row>(sql: string, params?: SqlValue[]): Promise<T[]>;
  /** Run a write statement. */
  run(sql: string, params?: SqlValue[]): Promise<{ changes: number }>;
}

/** Thrown by handlers; the router turns it into an HTTP-like error (status + detail) like FastAPI does. */
export class HttpError extends RouteError {
  constructor(status: number, detail: string) {
    super(status, detail);
    this.name = "HttpError";
  }
}
