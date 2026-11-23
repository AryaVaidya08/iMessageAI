import { describe, expect, it } from "vitest";

import type { IngestEvent } from "../../engine/protocol";
import { ingestReducer, initialIngestState, MAX_LOG_LINES, type IngestState } from "./reducer";

const run = (events: [IngestEvent, number][], s: IngestState = initialIngestState) =>
  events.reduce((st, [event, now]) => ingestReducer(st, { type: "event", event, now }), s);

describe("ingestReducer", () => {
  it("tracks phase and chat progress", () => {
    const s = run([
      [{ type: "phase", phase: "ingest", label: "Parsing" }, 0],
      [{ type: "chat-start", chatId: "a", name: "A", total: 10 }, 1],
      [{ type: "chat-progress", chatId: "a", name: "A", done: 4, total: 10 }, 2],
    ]);
    expect(s.phaseLabel).toBe("Parsing");
    expect(s.currentChat).toEqual({ chatId: "a", name: "A", done: 4, total: 10 });
    expect(s.running).toBe(true);
  });

  it("computes throughput and ETA from overall events", () => {
    const ov = (d: number): IngestEvent => ({
      type: "overall",
      messagesDone: d,
      messagesTotal: 1000,
      chatsDone: 0,
      chatsTotal: 2,
    });
    const s = run([[ov(0), 0], [ov(100), 1000], [ov(200), 2000]]);
    expect(s.throughput).toBeCloseTo(100);
    expect(s.etaSeconds).toBeCloseTo(8);
  });

  it("records errors and marks done", () => {
    const s = run([
      [{ type: "error", message: "boom", chatId: "a" }, 0],
      [{ type: "done" }, 1],
    ]);
    expect(s.errorCount).toBe(1);
    expect(s.lastError).toBe("boom");
    expect(s.log[0].level).toBe("error");
    expect(s.running).toBe(false);
    expect(s.finished).toBe(true);
  });

  it("stays finished after trailing log/memory events", () => {
    const s = run([
      [{ type: "done" }, 0],
      [{ type: "log", message: "late" }, 1],
      [{ type: "memory", usedMB: 1, limitMB: 2 }, 2],
    ]);
    expect(s.finished).toBe(true);
    expect(s.running).toBe(false);
  });

  it("starts a new run after done", () => {
    const s = run([
      [{ type: "done" }, 0],
      [{ type: "phase", phase: "ingest" }, 1],
    ]);
    expect(s.finished).toBe(false);
    expect(s.running).toBe(true);
    expect(s.log).toHaveLength(1);
  });

  it("stores memory", () => {
    expect(run([[{ type: "memory", usedMB: 5, limitMB: 10 }, 0]]).memory).toEqual({ usedMB: 5, limitMB: 10 });
  });

  it("caps the log", () => {
    const evs: [IngestEvent, number][] = Array.from({ length: MAX_LOG_LINES + 50 }, (_, i) => [
      { type: "log", message: `m${i}` },
      i,
    ]);
    const s = run(evs);
    expect(s.log).toHaveLength(MAX_LOG_LINES);
    expect(s.log[s.log.length - 1].text).toBe(`m${MAX_LOG_LINES + 49}`);
    expect(s.log[0].text).toBe("m50");
  });

  it("resets", () => {
    expect(ingestReducer(run([[{ type: "log", message: "x" }, 0]]), { type: "reset" })).toEqual(initialIngestState);
  });
});
