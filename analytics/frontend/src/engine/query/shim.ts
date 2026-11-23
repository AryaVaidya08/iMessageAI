// Adapter between unit 11's `({ db, params })` handler style and the real router (unit 8).
import { registerRoute as registerFlat, RouteError as RealRouteError } from "./router";

export interface SqlDb {
  /** Run a SELECT and return all rows as objects. */
  all<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  /** Run a statement (INSERT/UPDATE/DELETE/DDL). */
  run(sql: string, params?: unknown[]): Promise<unknown>;
  /** Run several statements without bindings. */
  exec(sql: string): Promise<void>;
}

export const RouteError = RealRouteError;

export interface RouteContext {
  db: SqlDb;
  /** Path params, query params and JSON body merged. */
  params: Record<string, any>;
}

export type RouteHandler = (ctx: RouteContext) => unknown | Promise<unknown>;

export function registerRoute(pattern: string, handler: RouteHandler): void {
  registerFlat(pattern, (db, params) => handler({ db: db as unknown as SqlDb, params }));
}

/** Run fn inside a transaction (the app DB is single-connection per worker, so BEGIN/COMMIT is safe). */
export async function inTransaction<T>(db: SqlDb, fn: () => Promise<T>): Promise<T> {
  await db.exec("BEGIN");
  try {
    const out = await fn();
    await db.exec("COMMIT");
    return out;
  } catch (e) {
    await db.exec("ROLLBACK");
    throw e;
  }
}
