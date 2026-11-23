// Minimal local stand-in for unit 8's route registry. Replace the import in
// people.ts / merge.ts with the real registerRoute when unit 8 lands.

export interface SqlDb {
  /** Run a SELECT and return all rows as objects. */
  all<T = Record<string, unknown>>(sql: string, params?: unknown[]): T[];
  /** Run a statement (INSERT/UPDATE/DELETE/DDL); returns rows changed when known. */
  run(sql: string, params?: unknown[]): number | void;
  /** Run several statements without bindings. */
  exec(sql: string): void;
}

export class RouteError extends Error {
  constructor(public status: number, public detail: string) {
    super(detail);
  }
}

export interface RouteContext {
  db: SqlDb;
  /** Path params, query params and JSON body merged (path wins). */
  params: Record<string, any>;
}

export type RouteHandler = (ctx: RouteContext) => unknown;

export const routes = new Map<string, RouteHandler>();

export function registerRoute(pattern: string, handler: RouteHandler): void {
  routes.set(pattern, handler);
}

/** Wrap a (db, params) function in a single-statement-group transaction. */
export function inTransaction<T>(db: SqlDb, fn: () => T): T {
  db.exec("BEGIN");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
