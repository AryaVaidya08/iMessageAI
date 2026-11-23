import { describe, expect, it } from "vitest";
import { createRpcClient, type RpcCancel, type RpcRequest, type RpcTransport } from "./rpc";

function fakeTransport() {
  const sent: (RpcRequest | RpcCancel)[] = [];
  const t: RpcTransport = { postMessage: (m) => void sent.push(m), addEventListener: () => {} };
  return { t, sent };
}

describe("rpc cancellation", () => {
  it("tells the worker to cancel an aborted request and never settles it", async () => {
    const { t, sent } = fakeTransport();
    const call = createRpcClient(t);
    const ac = new AbortController();
    let settled = false;
    call("GET /x", {}, ac.signal).then(() => (settled = true), () => (settled = true));
    ac.abort();
    await Promise.resolve();
    expect(sent).toEqual([{ id: 1, route: "GET /x", params: {} }, { cancel: 1 }]);
    expect(settled).toBe(false);
  });

  it("does not send a request whose signal is already aborted", () => {
    const { t, sent } = fakeTransport();
    const ac = new AbortController();
    ac.abort();
    createRpcClient(t)("GET /x", {}, ac.signal);
    expect(sent).toEqual([]);
  });
});
