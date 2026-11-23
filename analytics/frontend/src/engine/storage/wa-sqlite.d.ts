declare module "wa-sqlite/src/examples/AccessHandlePoolVFS.js" {
  export class AccessHandlePoolVFS {
    constructor(directoryPath: string);
    isReady: Promise<void>;
    name: string;
    close(): Promise<void>;
    getCapacity(): number;
    addCapacity(n: number): Promise<number>;
  }
}
declare module "wa-sqlite/dist/wa-sqlite.mjs" {
  const factory: (opts?: Record<string, unknown>) => Promise<unknown>;
  export default factory;
}
