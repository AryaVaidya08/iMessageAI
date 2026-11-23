// Tiny postMessage RPC shared by the query worker and the main-thread client.
export interface RpcRequest {
  id: number;
  route: string;
  params: Record<string, unknown>;
}
export type RpcResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; status: number; detail: string };

export interface RpcTransport {
  postMessage(msg: RpcRequest): void;
  addEventListener(type: "message", fn: (e: MessageEvent<RpcResponse>) => void): void;
}

export type RpcCall = <T>(route: string, params?: Record<string, unknown>) => Promise<T>;

export function createRpcClient(transport: RpcTransport): RpcCall {
  let next = 1;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  transport.addEventListener("message", (e) => {
    const msg = e.data;
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.ok) p.resolve(msg.result);
    else p.reject(Object.assign(new Error(msg.detail), { status: msg.status, detail: msg.detail }));
  });
  return function call<T>(route: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = next++;
    return new Promise<T>((resolve, reject) => {
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      transport.postMessage({ id, route, params });
    });
  };
}
