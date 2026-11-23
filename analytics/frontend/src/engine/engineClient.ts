// Main-thread handle to the single engine worker (queries + ingest share it; it owns the OPFS database).
import { createRpcClient, type RpcCall, type RpcTransport } from "./rpc";
import type { IngestEvent } from "./protocol";

let worker: Worker | null = null;
let call: RpcCall | null = null;
const ingestListeners = new Set<(e: IngestEvent) => void>();

function spawn(): Worker {
  const w = new Worker(new URL("./workers/engine.worker.ts", import.meta.url), { type: "module", name: "engine" });
  const transport = w as unknown as RpcTransport & { rejectAll?: (m: string) => void };
  call = createRpcClient(transport);
  w.addEventListener("message", (e: MessageEvent) => {
    const d = e.data as { id?: unknown; type?: string };
    if (typeof d?.id === "number" || !d?.type) return; // an RPC response
    ingestListeners.forEach((fn) => fn(e.data as IngestEvent));
  });
  const fail = (msg: string) => {
    transport.rejectAll?.(msg);
    ingestListeners.forEach((fn) => fn({ type: "error", fatal: true, message: msg }));
    w.terminate();
    worker = null;
    call = null;
  };
  w.addEventListener("error", (e) => fail(`engine worker error: ${e.message || "failed to load"}`));
  w.addEventListener("messageerror", () => fail("engine worker message error"));
  return w;
}

export function getEngineWorker(): Worker {
  return (worker ??= spawn());
}

export function onIngestEvent(fn: (e: IngestEvent) => void): () => void {
  ingestListeners.add(fn);
  return () => ingestListeners.delete(fn);
}

export function query<T>(route: string, params: Record<string, unknown> = {}): Promise<T> {
  getEngineWorker();
  return call!<T>(route, params);
}

/** Terminate the worker (it releases its OPFS handles), e.g. before deleting the stored data. */
export function resetEngine(): void {
  worker?.terminate();
  worker = null;
  call = null;
}
