declare module "wa-sqlite/src/examples/IDBBatchAtomicVFS.js" {
  export class IDBBatchAtomicVFS {
    constructor(
      idbDatabaseName?: string,
      options?: { durability?: "default" | "strict" | "relaxed"; purge?: "deferred" | "manual"; purgeAtLeast?: number },
    );
    name: string;
    close(): Promise<void>;
  }
}
declare module "wa-sqlite/dist/wa-sqlite-async.mjs" {
  const factory: (opts?: Record<string, unknown>) => Promise<unknown>;
  export default factory;
}
declare module "wa-sqlite/dist/wa-sqlite.mjs" {
  const factory: (opts?: Record<string, unknown>) => Promise<unknown>;
  export default factory;
}
