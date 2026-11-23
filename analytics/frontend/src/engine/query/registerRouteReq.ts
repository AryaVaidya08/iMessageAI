/**
 * Local route-registration shim. Unit 8 owns the real router; when it lands, replace the body of
 * this file with a re-export of the real `registerRoute` (the handler signature below is the
 * contract this unit codes against) and nothing else in query/ needs to change.
 */
import { HttpError, type QueryDb } from "./types";
import { registerRoute as registerFlatRoute } from "./router";

export interface RouteRequest {
  /** Path params, e.g. { id } for "/api/conversations/:id". */
  path: Record<string, string>;
  /** Query-string params (string values, as parsed from the URL, or numbers when called directly). */
  query: Record<string, string | number | undefined>;
  /** Parsed JSON body for POST routes. */
  body?: unknown;
}

export type RouteHandler = (db: QueryDb, req: RouteRequest) => Promise<unknown>;

interface Registered {
  method: string;
  segments: string[];
  handler: RouteHandler;
}

const routes: Registered[] = [];

/** pattern is "METHOD /api/path/:param", e.g. "GET /api/conversations/:id/messages". */
export function registerRoute(pattern: string, handler: RouteHandler): void {
  const [method, path] = pattern.split(" ");
  const entry = { method, segments: path.split("/").filter(Boolean), handler };
  // Idempotent: re-registering the same pattern replaces the earlier handler.
  const i = routes.findIndex((r) => r.method === method && r.segments.join("/") === entry.segments.join("/"));
  if (i >= 0) routes[i] = entry;
  else routes.push(entry);
  // Also register with the real router (unit 8). The client sends ONE flat params object
  // (path params + query params + POST body fields), so split it here by the :names in the pattern.
  registerFlatRoute(pattern, (db, params) => {
    const names = new Set(entry.segments.filter((s) => s.startsWith(":")).map((s) => s.slice(1)));
    const path: Record<string, string> = {};
    const rest: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(params)) {
      if (names.has(k)) path[k] = String(v);
      else rest[k] = v;
    }
    return handler(db as unknown as QueryDb, {
      path,
      query: rest as Record<string, string | number | undefined>,
      body: method === "POST" ? rest : undefined,
    });
  });
}

function decodePart(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    throw new HttpError(400, "malformed path");
  }
}

/** Dispatch helper used by the local shim and by tests. */
export async function dispatchRoute(
  db: QueryDb,
  method: string,
  url: string,
  body?: unknown,
): Promise<unknown> {
  const [rawPath, qs = ""] = url.split("?");
  const parts = rawPath.split("/").filter(Boolean);
  const query: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(qs)) query[k] = v;
  for (const r of routes) {
    if (r.method !== method || r.segments.length !== parts.length) continue;
    const path: Record<string, string> = {};
    let ok = true;
    for (let i = 0; i < parts.length && ok; i++) {
      if (r.segments[i].startsWith(":")) path[r.segments[i].slice(1)] = decodePart(parts[i]);
      else ok = r.segments[i] === parts[i];
    }
    if (ok) return r.handler(db, { path, query, body });
  }
  throw new HttpError(404, `no route for ${method} ${rawPath}`);
}
