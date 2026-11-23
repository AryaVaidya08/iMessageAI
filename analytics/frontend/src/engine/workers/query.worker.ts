/// <reference lib="webworker" />
import { dispatch, RouteError } from "../query/router";
import { openAppDb } from "../query/openDb";
import type { QueryDb } from "../query/db";
import type { RpcRequest, RpcResponse } from "../rpc";
import "../query/routes";

let dbPromise: Promise<QueryDb> | null = null;
const getDb = () =>
  (dbPromise ??= openAppDb().catch((e) => {
    dbPromise = null;
    throw e;
  }));

self.addEventListener("message", async (e: MessageEvent<RpcRequest>) => {
  const { id, route, params } = e.data;
  let res: RpcResponse;
  try {
    res = { id, ok: true, result: await dispatch(getDb, route, params) };
  } catch (err) {
    res =
      err instanceof RouteError
        ? { id, ok: false, status: err.status, detail: err.detail }
        : { id, ok: false, status: 500, detail: err instanceof Error ? err.message : String(err) };
  }
  (self as unknown as Worker).postMessage(res);
});
