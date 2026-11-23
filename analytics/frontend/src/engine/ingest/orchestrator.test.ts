import { describe, expect, it } from "vitest";
import type { IngestEvent } from "../protocol";
import { registerSummaryHook, runIngest } from "./orchestrator";
import { appendMessages, makeExtractor, makeReader, makeSource, makeStore, makeWriter } from "./fakes";

function setup(spec = [{ name: "A", n: 25 }, { name: "B", n: 10, group: true }]) {
  const src = makeSource(spec);
  const store = makeStore();
  const events: IngestEvent[] = [];
  const run = async (opts: { batchSize?: number; signal?: AbortSignal; onEmit?: (e: IngestEvent) => void } = {}) => {
    events.length = 0;
    await runIngest({
      deps: { reader: makeReader(src), extractor: makeExtractor(src), writer: makeWriter(store) },
      emit: (e) => {
        events.push(e);
        opts.onEmit?.(e);
      },
      signal: opts.signal ?? new AbortController().signal,
      options: { batchSize: opts.batchSize ?? 10 },
      sampleMemory: () => ({ usedMB: 1, limitMB: 2 }),
    });
  };
  return { src, store, events, run };
}
const types = (ev: IngestEvent[]) => ev.map((e) => e.type);

describe("orchestrator", () => {
  it("ingests chat by chat with one tx per batch and emits events", async () => {
    const { store, events, run } = setup();
    await run();
    expect(store.messages.size).toBe(35);
    expect(store.txCount).toBe(3 + 1); // A: 10+10+5, B: 10
    expect(types(events).filter((t) => t === "chat-start")).toHaveLength(2);
    expect(types(events).filter((t) => t === "data-changed").length).toBeGreaterThanOrEqual(2);
    expect(events.some((e) => e.type === "log" && e.message === "parsing A (1/2)")).toBe(true);
    const last = events.filter((e) => e.type === "overall").pop() as any;
    expect(last).toMatchObject({ messagesDone: 35, messagesTotal: 35, chatsDone: 2, chatsTotal: 2 });
    expect(events[events.length - 1]).toMatchObject({ type: "done", inserted: 35, cancelled: false });
  });

  it("skips when fingerprint is unchanged", async () => {
    const { run, events } = setup();
    await run();
    await run();
    expect(events[events.length - 1]).toMatchObject({ type: "done", skipped: true });
  });

  it("incremental: only new rows parsed, hooks get changed chats", async () => {
    const { src, store, run, events } = setup();
    await run();
    const seen: string[][] = [];
    const off = registerSummaryHook((ids) => void seen.push(ids));
    appendMessages(src, "B", 7);
    await run();
    off();
    expect(store.messages.size).toBe(42);
    expect(events.filter((e) => e.type === "chat-start")).toHaveLength(1);
    expect(events[events.length - 1]).toMatchObject({ inserted: 7, chatsChanged: 1 });
    expect(seen).toEqual([["chat-B"]]);
  });

  it("detects edits and retractions of stored messages", async () => {
    const { src, store, run, events } = setup();
    await run();
    const m = src.messages.get("chat-A")![3];
    m.dateEdited = "2024-02-01T00:00:00.000Z";
    m.text = "edited";
    src.messages.get("chat-A")![4].dateRetracted = "2024-02-02T00:00:00.000Z";
    appendMessages(src, "B", 1); // changes fingerprint
    await run();
    expect(events[events.length - 1]).toMatchObject({ updated: 2, inserted: 1 });
    expect(store.messages.get(m.guid)!.text).toBe("edited");
  });

  it("cancel then resume continues from stored rowids without duplicates", async () => {
    const { store, run, events } = setup();
    const ac = new AbortController();
    let progress = 0;
    await run({ signal: ac.signal, onEmit: (e) => { if (e.type === "chat-progress" && ++progress === 2) ac.abort(); } });
    expect(events[events.length - 1]).toMatchObject({ type: "done", cancelled: true });
    const partial = store.messages.size;
    expect(partial).toBeGreaterThan(0);
    expect(partial).toBeLessThan(35);
    expect(store.sync.has("chat_db_fingerprint")).toBe(false);
    await run();
    expect(store.messages.size).toBe(35);
    expect(events[events.length - 1]).toMatchObject({ inserted: 35 - partial, cancelled: false });
  });

  it("holds one batch in flight at a time", async () => {
    const src = makeSource([{ name: "Big", n: 100 }]);
    const ex = makeExtractor(src);
    let pulled = 0, written = 0, maxLead = 0;
    const wrapped = {
      ...ex,
      async *extractChat(c: any, o: any) {
        for await (const b of ex.extractChat(c, o)) {
          pulled++;
          maxLead = Math.max(maxLead, pulled - written);
          yield b;
        }
      },
    };
    const w = makeWriter(makeStore());
    await runIngest({
      deps: { reader: makeReader(src), extractor: wrapped, writer: { ...w, writeBatch: async (...a) => { written++; return w.writeBatch(...a); } } },
      emit: () => {},
      signal: new AbortController().signal,
      options: { batchSize: 10 },
    });
    expect(maxLead).toBe(1);
  });
});
