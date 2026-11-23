/// <reference lib="webworker" />
// The ONE worker that owns the database (OPFS, exclusive handles): it serves analytics queries (RPC) and runs imports
// (IngestCommand), interleaving them. Ingest yields between batches, so a page's queries are answered while an
// import is running.
import type { IngestCommand, IngestEvent } from "../protocol";
import { runIngest } from "../ingest/orchestrator";
import { createRealDeps } from "../ingest/deps";
import { dispatch, RouteError } from "../query/router";
import { adaptAppDb } from "../query/openDb";
import { openAppDb, sqliteWasmBytes, type AppDb } from "../storage/db";
import type { QueryDb } from "../query/db";
import type { RpcRequest, RpcResponse } from "../rpc";
import "../query/routes";

const post = (m: IngestEvent | RpcResponse) => (self as unknown as Worker).postMessage(m);

let appPromise: Promise<AppDb> | null = null;
const getApp = () =>
  (appPromise ??= openAppDb().catch((e) => {
    appPromise = null;
    throw e;
  }));
let queryDb: QueryDb | null = null;
const getQueryDb = async () => (queryDb ??= adaptAppDb(await getApp()));

// ---- queries --------------------------------------------------------------------------------------------------
class RequestCancelled extends Error {}
const activeRpc = new Set<number>(); // received, not finished
const cancelledRpc = new Set<number>(); // subset the client no longer wants

/** A view of the DB that refuses new statements once the request was cancelled, so a long handler stops early. */
function guardDb(db: QueryDb, id: number): QueryDb {
  return new Proxy(db, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver);
      if (typeof v !== "function") return v;
      return (...args: unknown[]) => {
        if (cancelledRpc.has(id)) throw new RequestCancelled();
        return v.apply(target, args);
      };
    },
  });
}

async function handleRpc(req: RpcRequest) {
  activeRpc.add(req.id);
  let res: RpcResponse;
  try {
    // Requests queued behind a slow one are dropped here if they were cancelled while waiting.
    if (cancelledRpc.has(req.id)) throw new RequestCancelled();
    res = {
      id: req.id,
      ok: true,
      result: await dispatch(async () => guardDb(await getQueryDb(), req.id), req.route, req.params),
    };
  } catch (err) {
    if (err instanceof RequestCancelled) {
      activeRpc.delete(req.id);
      cancelledRpc.delete(req.id);
      return; // the client already stopped listening
    }
    res =
      err instanceof RouteError
        ? { id: req.id, ok: false, status: err.status, detail: err.detail }
        : { id: req.id, ok: false, status: 500, detail: err instanceof Error ? err.message : String(err) };
  }
  const wasCancelled = cancelledRpc.delete(req.id);
  activeRpc.delete(req.id);
  if (!wasCancelled) post(res);
}

// ---- ingest ---------------------------------------------------------------------------------------------------
let abort: AbortController | null = null;

async function handleIngest(cmd: Extract<IngestCommand, { type: "start" }>) {
  if (abort) return;
  abort = new AbortController();
  const emit = (e: IngestEvent) => post(e);
  let deps: Awaited<ReturnType<typeof createRealDeps>> | null = null;
  try {
    if (navigator.storage?.estimate) {
      const { quota = 0, usage = 0 } = await navigator.storage.estimate();
      const need = cmd.files?.chatDb?.size ?? 0;
      emit({ type: "log", level: "info", ts: Date.now(), message: `storage: ${Math.round(usage / 1048576)} MB used of ${Math.round(quota / 1048576)} MB` });
      if (quota && quota - usage < need * 0.3) {
        emit({ type: "error", fatal: true, message: "Not enough browser storage available for this chat.db" });
        return;
      }
    }
    const app = await getApp();
    deps = await createRealDeps(cmd.files, { app });
    await runIngest({
      deps,
      emit,
      signal: abort.signal,
      files: cmd.files,
      options: cmd.options,
      // real figure: the SQLite wasm heap(s) in this worker, against the 500 MB budget
      sampleMemory: () => ({ usedMB: Math.round(sqliteWasmBytes() / 1048576), limitMB: 500 }),
    });
  } catch (e) {
    emit({ type: "error", fatal: true, message: (e as Error).message ?? String(e) });
  } finally {
    try { deps?.dispose(); } catch { /* ignore */ }
    try { await deps?.reader.close(); } catch { /* ignore */ }
    abort = null;
  }
}

self.addEventListener("message", (e: MessageEvent<IngestCommand | RpcRequest | { cancel: number }>) => {
  const d = e.data as { type?: string; id?: number; cancel?: number };
  if (typeof d.cancel === "number") {
    if (activeRpc.has(d.cancel)) cancelledRpc.add(d.cancel);
  } else if (d.type === "cancel") abort?.abort();
  else if (d.type === "start") void handleIngest(e.data as Extract<IngestCommand, { type: "start" }>);
  else if (typeof d.id === "number") void handleRpc(e.data as RpcRequest);
});
