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

// ---- cancellation ---------------------------------------------------------------------------------------------
// Read queries (GET) are cancellable: the worker is single-threaded, so a slow query nobody is waiting for any more
// would otherwise block every query behind it. Writes (POST) are never cancelled.
const inflightReads = new Set<AbortController>();
let ambientScope: AbortController | null = null;

/**
 * Call at the top of an effect: every read query started synchronously in the rest of that effect body is cancelled
 * when the returned function is called (i.e. from the effect's cleanup: deps changed or the page unmounted).
 */
export function scopeRequests(): () => void {
  const scope = new AbortController();
  ambientScope = scope;
  queueMicrotask(() => {
    if (ambientScope === scope) ambientScope = null;
  });
  return () => scope.abort();
}

/** Cancel every read still in flight (used when the user navigates to another page). */
export function cancelAllReads(): void {
  for (const ac of [...inflightReads]) ac.abort();
}

export function query<T>(route: string, params: Record<string, unknown> = {}): Promise<T> {
  getEngineWorker();
  if (!route.startsWith("GET ")) return call!<T>(route, params);
  const ac = new AbortController();
  const scope = ambientScope;
  const onScopeAbort = () => ac.abort();
  if (scope?.signal.aborted) ac.abort();
  else scope?.signal.addEventListener("abort", onScopeAbort, { once: true });
  inflightReads.add(ac);
  return call!<T>(route, params, ac.signal).finally(() => {
    inflightReads.delete(ac);
    scope?.signal.removeEventListener("abort", onScopeAbort);
  });
}

/** Terminate the worker (it releases its OPFS handles), e.g. before deleting the stored data. */
export function resetEngine(): void {
  worker?.terminate();
  worker = null;
  call = null;
  inflightReads.clear();
}
