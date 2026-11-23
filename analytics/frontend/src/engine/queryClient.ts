import { createRpcClient, type RpcCall, type RpcTransport } from "./rpc";

let call: RpcCall | null = null;

/** Lazily spawns the query worker and sends query(route, params). */
export function query<T>(route: string, params: Record<string, unknown> = {}): Promise<T> {
  if (!call) {
    const worker = new Worker(new URL("./workers/query.worker.ts", import.meta.url), { type: "module" });
    const transport = worker as unknown as RpcTransport & { rejectAll?: (m: string) => void };
    call = createRpcClient(transport);
    const fail = (msg: string) => {
      transport.rejectAll?.(msg);
      worker.terminate();
      call = null; // respawn on next query
    };
    worker.addEventListener("error", (e) => fail(`query worker error: ${e.message || "failed to load"}`));
    worker.addEventListener("messageerror", () => fail("query worker message error"));
  }
  return call<T>(route, params);
}
