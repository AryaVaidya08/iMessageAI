import type { QueryDb } from "./db";

export type Params = Record<string, unknown>;
export type RouteHandler = (db: QueryDb, params: Params) => unknown | Promise<unknown>;

/** Error carrying an HTTP-like status so the client can keep the old error shape. */
export class RouteError extends Error {
  status: number;
  detail: string;
  constructor(status: number, detail: string) {
    super(detail);
    this.name = "RouteError";
    this.status = status;
    this.detail = detail;
  }
}

const routes = new Map<string, RouteHandler>();

/** Register a handler, e.g. registerRoute("GET /api/overview", (db, p) => ...). */
export function registerRoute(name: string, handler: RouteHandler): void {
  routes.set(name, handler);
}

export function hasRoute(name: string): boolean {
  return routes.has(name);
}

/** `db` may be null only when the route is unregistered (error is thrown first). */
export async function dispatch(
  getDb: () => Promise<QueryDb>,
  route: string,
  params: Params = {},
): Promise<unknown> {
  const handler = routes.get(route);
  if (!handler) throw new RouteError(501, `route not implemented yet: ${route}`);
  return handler(await getDb(), params);
}
