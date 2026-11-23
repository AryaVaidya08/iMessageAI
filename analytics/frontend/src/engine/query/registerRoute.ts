// Local shim: unit 8 replaces this file with the real route registry.
export type Row = Record<string, unknown>;

export interface QueryDb {
  all(sql: string, params?: unknown[]): Promise<Row[]>;
  get(sql: string, params?: unknown[]): Promise<Row | undefined>;
  /** Execute a write statement (no result rows). */
  run(sql: string, params?: unknown[]): Promise<void>;
}

export type RouteHandler = (db: QueryDb, params: Record<string, unknown>) => Promise<unknown>;

export const routes = new Map<string, RouteHandler>();

export function registerRoute(key: string, handler: RouteHandler): void {
  routes.set(key, handler);
}
