import { beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { QueryDb } from "./registerRoute";
import {
  OVERVIEW_SUMMARY_DDL,
  bucketVolume,
  downsample,
  getFastestReplyRelationship,
  getHeatmap,
  getOverview,
  getTopConversations,
  getVolume,
  refreshOverviewSummary,
} from "./overview";

const dir = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__");
const golden = JSON.parse(readFileSync(join(dir, "overview.golden.json"), "utf8"));

function wrap(d: Database.Database): QueryDb {
  return {
    all: async (sql, p = []) => d.prepare(sql).all(...(p as unknown[])) as never,
    get: async (sql, p = []) => d.prepare(sql).get(...(p as unknown[])) as never,
    run: async (sql, p = []) => void d.prepare(sql).run(...(p as unknown[])),
  };
}

let raw: Database.Database;
let db: QueryDb;
beforeEach(() => {
  raw = new Database(readFileSync(join(dir, "overview.fixture.db")));
  raw.exec(OVERVIEW_SUMMARY_DDL);
  db = wrap(raw);
});

describe("overview parity with Python goldens", () => {
  it("stats", async () => expect(await getOverview(db)).toEqual(golden.stats));
  it.each(["day", "week", "month"])("volume %s", async (g) => {
    expect(await getVolume(db, { granularity: g })).toEqual({ points: golden.volume[g] });
  });
  it.each(["1", "3", "10"])("top conversations limit %s", async (l) => {
    expect(await getTopConversations(db, { limit: Number(l) })).toEqual({ items: golden.top[l] });
  });
  it("heatmap", async () => expect(await getHeatmap(db)).toEqual(golden.heatmap));
  it("fastest reply relationship", async () => {
    const r = await getFastestReplyRelationship(db);
    expect(r?.relationship_type).toBe(golden.fastest.relationship_type);
    expect(r?.median_reply_seconds).toBeCloseTo(golden.fastest.median_reply_seconds, 6);
  });
  it("rejects bad params", async () => {
    await expect(getVolume(db, { granularity: "year" })).rejects.toThrow();
    await expect(getTopConversations(db, { limit: 0 })).rejects.toThrow();
  });
});

describe("incremental refresh and aliases", () => {
  it("refreshOverviewSummary picks up new messages for one conversation", async () => {
    await getOverview(db);
    raw.prepare(
      "INSERT INTO messages(id,conversation_id,sender_id,timestamp,text) VALUES ('new1','c1','me','2030-01-01T00:00:00.000Z','x')",
    ).run();
    expect((await getOverview(db)).total_messages).toBe(golden.stats.total_messages); // stale until refreshed
    await refreshOverviewSummary(db, ["c1"]);
    const o = await getOverview(db);
    expect(o.total_messages).toBe(golden.stats.total_messages + 1);
    expect(o.date_range_end).toBe("2030-01-01T00:00:00.000Z");
  });

  it("conversation merge aliases combine counts", async () => {
    const before = await getTopConversations(db, { limit: 50 });
    const c = (id: string) => before.items.find((i) => i.conversation_id === id)!.message_count;
    raw.prepare("INSERT INTO conversation_alias VALUES ('c5','c2')").run();
    const o = await getOverview(db);
    expect(o.total_conversations).toBe(4);
    const after = await getTopConversations(db, { limit: 50 });
    expect(after.items.find((i) => i.conversation_id === "c2")!.message_count).toBe(c("c2") + c("c5"));
    expect(after.items.find((i) => i.conversation_id === "c5")).toBeUndefined();
    expect(o.total_messages).toBe(golden.stats.total_messages);
  });

  it("participant merge removes replies between merged senders", async () => {
    await getFastestReplyRelationship(db);
    raw.prepare("INSERT INTO participant_alias VALUES ('+15551110004','+15551110002')").run();
    expect((await getOverview(db)).total_participants).toBe(4);
    await refreshOverviewSummary(db);
    const n = raw.prepare("SELECT SUM(n) s FROM summary_reply_delta").get() as { s: number };
    expect(n.s).toBeGreaterThan(0);
  });
});

describe("pure helpers", () => {
  it("bucketVolume fills gaps and week starts Monday", () => {
    expect(bucketVolume([["2024-01-03", 2], ["2024-01-06", 1]], "day")).toEqual([
      ["2024-01-03", 2], ["2024-01-04", 0], ["2024-01-05", 0], ["2024-01-06", 1],
    ]);
    expect(bucketVolume([["2024-01-03", 2], ["2024-01-08", 1]], "week")).toEqual([
      ["2024-01-01", 2], ["2024-01-08", 1],
    ]);
    expect(bucketVolume([], "day")).toEqual([]);
  });
  it("downsample caps at 1000 points and preserves total", () => {
    const pts = Array.from({ length: 3500 }, (_, i) => ({ bucket: String(i), count: 1 }));
    const out = downsample(pts);
    expect(out.length).toBeLessThanOrEqual(1000);
    expect(out.reduce((a, p) => a + p.count, 0)).toBe(3500);
  });
});
