import { createRpcClient, type RpcCall } from "./rpc";

let call: RpcCall | null = null;

/** Lazily spawns the query worker and sends query(route, params). */
export function query<T>(route: string, params: Record<string, unknown> = {}): Promise<T> {
  if (!call) {
    const worker = new Worker(new URL("./workers/query.worker.ts", import.meta.url), { type: "module" });
    call = createRpcClient(worker);
  }
  return call<T>(route, params);
}
