import type { QueryDb } from "./db";

/**
 * Opens the app DB in the query worker. Wire this to unit 1's storage layer
 * (OPFS SQLite) once it lands; until then routes fail with a clear error.
 */
export async function openAppDb(): Promise<QueryDb> {
  throw new Error("app database storage not available yet");
}
