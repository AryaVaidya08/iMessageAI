// node:sqlite loaded via require: Vite/vitest strips the `node:` prefix from static imports and then fails to
// resolve the bare "sqlite" builtin. createRequire sidesteps that and works the same under tsx.
import { createRequire } from "node:module";
import type { DatabaseSync as DB, StatementSync as ST } from "node:sqlite";

const mod = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
export const DatabaseSync = mod.DatabaseSync;
export type DatabaseSync = DB;
export type StatementSync = ST;
