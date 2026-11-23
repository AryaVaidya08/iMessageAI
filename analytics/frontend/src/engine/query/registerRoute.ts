// Flat-params route registration: re-exports the real router (unit 8).
// Handlers receive (db, params) where params is the flat object the client sends
// (path params + query params + POST body fields).
export { registerRoute, dispatch, hasRoute, RouteError } from "./router";
export type { RouteHandler, Params } from "./router";
export type { QueryDb } from "./db";
export type Row = Record<string, unknown>;
