// Tiny postMessage RPC shared by the query worker and the main-thread client.
export interface RpcRequest {
  id: number;
  route: string;
  params: Record<string, unknown>;
}
export type RpcResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; status: number; detail: string };

/** Tells the worker it may drop request `cancel` (not started yet) or abort it at its next DB call. */
export interface RpcCancel {
  cancel: number;
}

export interface RpcTransport {
  postMessage(msg: RpcRequest | RpcCancel): void;
  addEventListener(type: "message", fn: (e: MessageEvent<RpcResponse>) => void): void;
}

/**
 * With a signal, aborting tells the worker to stop working on the request. The returned promise then NEVER settles
 * (callers are already gone, so neither a result nor an error should reach them).
 */
export type RpcCall = <T>(route: string, params?: Record<string, unknown>, signal?: AbortSignal) => Promise<T>;

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
  // Lets the owner of the worker reject everything in flight if it crashes.
  (transport as RpcTransport & { rejectAll?: (m: string) => void }).rejectAll = (m) => {
    for (const p of pending.values()) p.reject(Object.assign(new Error(m), { status: 500, detail: m }));
    pending.clear();
  };
  return function call<T>(route: string, params: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
    const id = next++;
    return new Promise<T>((resolve, reject) => {
      if (signal?.aborted) return; // cancelled before it was sent
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      transport.postMessage({ id, route, params });
      signal?.addEventListener(
        "abort",
        () => {
          if (pending.delete(id)) transport.postMessage({ cancel: id });
        },
        { once: true },
      );
    });
  };
}
