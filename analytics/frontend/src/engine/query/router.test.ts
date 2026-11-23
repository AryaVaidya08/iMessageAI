import { describe, expect, it } from "vitest";
import { dispatch, registerRoute, RouteError } from "./router";
import { createRpcClient, type RpcRequest, type RpcResponse } from "../rpc";
import type { QueryDb } from "./db";

const fakeDb: QueryDb = {
  async all(_sql, _bind) {
    return [{ n: 42 }];
  },
  async get(_sql, _bind) {
    return { n: 42 };
  },
  async run() {},
};
const getDb = async () => fakeDb;

describe("router", () => {
  it("dispatches to registered handler with db and params", async () => {
    registerRoute("GET /api/test", async (db, p) => ({ n: (await db.all("select 1"))[0].n, id: p.id }));
    expect(await dispatch(getDb, "GET /api/test", { id: "x" })).toEqual({ n: 42, id: "x" });
  });

  it("returns a clear error for unregistered routes without opening the db", async () => {
    let opened = false;
    const p = dispatch(async () => ((opened = true), fakeDb), "GET /api/nope", {});
    await expect(p).rejects.toThrow("route not implemented yet: GET /api/nope");
    await expect(p).rejects.toBeInstanceOf(RouteError);
    expect(opened).toBe(false);
  });
});

describe("rpc client", () => {
  function loopback() {
    let listener: (e: MessageEvent<RpcResponse>) => void = () => {};
    const transport = {
      addEventListener: (_: "message", fn: typeof listener) => {
        listener = fn;
      },
      postMessage: async (req: RpcRequest) => {
        let res: RpcResponse;
        try {
          res = { id: req.id, ok: true, result: await dispatch(getDb, req.route, req.params) };
        } catch (e) {
          const err = e as RouteError;
          res = { id: req.id, ok: false, status: err.status ?? 500, detail: err.message };
        }
        listener({ data: res } as MessageEvent<RpcResponse>);
      },
    };
    return createRpcClient(transport);
  }

  it("round-trips results and maps errors", async () => {
    registerRoute("GET /api/rt", (_db, p) => ({ echo: p.v }));
    const call = loopback();
    expect(await call("GET /api/rt", { v: 1 })).toEqual({ echo: 1 });
    await expect(call("GET /api/missing")).rejects.toMatchObject({ status: 501 });
  });
});
