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

/**
 * Maps a legacy-style request ("GET", "/api/conversations/ab%20c/messages?limit=5") to a registered route
 * name plus the flat params object the client sends (path params + query params + POST body fields).
 * Used by tests and tools; the app itself calls dispatch(route, params) directly.
 */
export function resolveRoute(
  method: string,
  url: string,
  body?: Record<string, unknown>,
): { route: string; params: Params } | null {
  const [rawPath, qs = ""] = url.split("?");
  const parts = rawPath.split("/").filter(Boolean);
  for (const name of routes.keys()) {
    const [m, pattern] = name.split(" ");
    if (m !== method) continue;
    const segs = pattern.split("/").filter(Boolean);
    if (segs.length !== parts.length) continue;
    const params: Params = {};
    let ok = true;
    for (let i = 0; i < segs.length && ok; i++) {
      if (segs[i].startsWith(":")) params[segs[i].slice(1)] = decodeURIComponent(parts[i]);
      else ok = segs[i] === parts[i];
    }
    if (!ok) continue;
    for (const [k, v] of new URLSearchParams(qs)) params[k] = v;
    return { route: name, params: { ...params, ...(body ?? {}) } };
  }
  return null;
}

/** The DB is only opened (via getDb) once the route is known to exist. */
export async function dispatch(
  getDb: () => Promise<QueryDb>,
  route: string,
  params: Params = {},
): Promise<unknown> {
  const handler = routes.get(route);
  if (!handler) throw new RouteError(501, `route not implemented yet: ${route}`);
  return handler(await getDb(), params);
}
