import { beforeAll, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import "../conversations";
import {
  bucketVolume,
  longestSilence,
  longestStreakDays,
  refreshConversationSummary,
  resetSearchCapabilityCache,
  splitWindowLimits,
} from "../conversations";
import { FTS_BACKFILL_SQL, FTS_MIGRATION_STATEMENTS } from "../conversationsSchema";
import { dispatchRoute } from "../registerRoute";
import { HttpError, type QueryDb } from "../types";
import { buildDb, loadGolden, nodeDb } from "./helpers";

const golden = loadGolden();

/** Fields produced by unit 12's text analytics; the default stub can't reproduce them, so they're masked. */
const MASKED_LEADERBOARD = ["happiest_message", "most_aggressive_message", "most_emoji_message"];

function normalize(url: string, body: any): any {
  const b = JSON.parse(JSON.stringify(body));
  if (url.includes("/participant-stats")) {
    for (const p of b.participants) {
      for (const k of ["top_words", "top_emojis", "sentiment_series", "personality"]) delete p[k];
      for (const k of ["tapbacks_given", "tapbacks_received"]) {
        p[k].sort((x: any, y: any) => y.count - x.count || x.action.localeCompare(y.action));
      }
    }
  }
  if (url.includes("/personality-leaderboard")) return { traits: b.traits.map((t: any) => t.trait) };
  if (url.includes("/leaderboard")) for (const k of MASKED_LEADERBOARD) delete b[k];
  if (url.includes("/leaderboard") && !url.includes("personality")) delete b.angriest_message;
  if (url.includes("/reply-graph")) {
    b.edges.sort((x: any, y: any) => y.count - x.count || x.replier_id.localeCompare(y.replier_id) || x.original_id.localeCompare(y.original_id));
  }
  return b;
}

function expectClose(actual: any, expected: any, path = "$"): void {
  if (typeof expected === "number" && typeof actual === "number") {
    expect(Math.abs(actual - expected), `${path}: ${actual} vs ${expected}`).toBeLessThan(2e-3);
  } else if (Array.isArray(expected)) {
    expect(Array.isArray(actual), path).toBe(true);
    expect(actual.length, `${path} length`).toBe(expected.length);
    expected.forEach((e, i) => expectClose(actual[i], e, `${path}[${i}]`));
  } else if (expected && typeof expected === "object") {
    expect(Object.keys(actual).sort(), `${path} keys`).toEqual(Object.keys(expected).sort());
    for (const k of Object.keys(expected)) expectClose(actual[k], expected[k], `${path}.${k}`);
  } else {
    expect(actual, path).toEqual(expected);
  }
}

let raw: DatabaseSync;
let db: QueryDb;
beforeAll(() => {
  raw = buildDb();
  db = nodeDb(raw);
});

async function call(url: string): Promise<{ status: number; body: any }> {
  try {
    return { status: 200, body: await dispatchRoute(db, "GET", url) };
  } catch (e) {
    if (e instanceof HttpError) return { status: e.status, body: { detail: e.detail } };
    throw e;
  }
}

describe("golden parity with the Python implementation", () => {
  for (const [url, g] of Object.entries(golden)) {
    it(url, async () => {
      const res = await call(url);
      expect(res.status).toBe(g.status);
      if (g.status === 200) expectClose(normalize(url, res.body), normalize(url, g.body));
    });
  }
});

describe("pure helpers", () => {
  it("buckets volume with gap filling", () => {
    expect(bucketVolume([["2024-01-01", 2], ["2024-01-04", 1]], "day")).toEqual([
      ["2024-01-01", 2], ["2024-01-02", 0], ["2024-01-03", 0], ["2024-01-04", 1],
    ]);
    // 2024-01-01 is a Monday.
    expect(bucketVolume([["2024-01-01", 2], ["2024-01-08", 1], ["2024-01-14", 5]], "week")).toEqual([
      ["2024-01-01", 2], ["2024-01-08", 6],
    ]);
    expect(bucketVolume([["2024-01-31", 1], ["2024-02-01", 2]], "month")).toEqual([["2024-01", 1], ["2024-02", 2]]);
    expect(bucketVolume([], "week")).toEqual([]);
  });
  it("streak and silence", () => {
    const days = [
      { day: "2024-01-01", start_ts: "2024-01-01T08:00:00", end_ts: "2024-01-01T09:00:00" },
      { day: "2024-01-02", start_ts: "2024-01-02T08:00:00", end_ts: "2024-01-02T09:00:00" },
      { day: "2024-01-05", start_ts: "2024-01-05T09:00:00.500Z", end_ts: "2024-01-05T10:00:00Z" },
    ];
    expect(longestStreakDays(days)).toBe(2);
    expect(longestSilence(days)).toMatchObject({ before: "2024-01-02T09:00:00", after: "2024-01-05T09:00:00.500Z" });
    expect(longestSilence(days)!.gap_seconds).toBeCloseTo(3 * 86400 - 0 + 0.5, 3);
  });
  it("window limits", () => {
    expect(splitWindowLimits(11)).toEqual([5, 5]);
    expect(splitWindowLimits(1)).toEqual([0, 1]);
  });
});

describe("validation and writes", () => {
  it("rejects bad params with 422", async () => {
    expect((await call("/api/conversations?sort=bad")).status).toBe(422);
    expect((await call("/api/conversations?page=0")).status).toBe(422);
    expect((await call("/api/conversations/c1/messages?limit=501")).status).toBe(422);
    expect((await call("/api/conversations/c1/messages/search")).status).toBe(422);
  });
  it("updates relationship type", async () => {
    const d: any = await dispatchRoute(db, "POST", "/api/conversations/c3/relationship-type", { relationship_type: "boss" });
    expect(d.relationship_type).toBe("boss");
    const again: any = await dispatchRoute(db, "GET", "/api/conversations/c3");
    expect(again.relationship_type).toBe("boss");
    await dispatchRoute(db, "POST", "/api/conversations/c3/relationship-type", { relationship_type: "other" });
    await expect(dispatchRoute(db, "POST", "/api/conversations/c3/relationship-type", { relationship_type: "nope" })).rejects.toMatchObject({ status: 400 });
    await expect(dispatchRoute(db, "POST", "/api/conversations/zzz/relationship-type", { relationship_type: "boss" })).rejects.toMatchObject({ status: 404 });
  });
});

describe("summary table", () => {
  it("refresh matches live aggregation", async () => {
    const before: any = await dispatchRoute(db, "GET", "/api/conversations?page_size=100");
    await refreshConversationSummary(db, ["c1", "c2", "c3", "c4", "c5"]);
    const after: any = await dispatchRoute(db, "GET", "/api/conversations?page_size=100");
    expect(after).toEqual(before);
    raw.prepare("INSERT INTO messages (id, conversation_id, sender_id, timestamp, text) VALUES ('new1','c3','me','2030-01-01T00:00:00','x')").run();
    await refreshConversationSummary(db, ["c3"]);
    const c3: any = await dispatchRoute(db, "GET", "/api/conversations/c3");
    expect(c3.last_message_at).toBe("2030-01-01T00:00:00");
    raw.prepare("DELETE FROM messages WHERE id = 'new1'").run();
    await refreshConversationSummary(db, ["c3"]);
  });
});

describe("search index", () => {
  it("FTS5 path returns the same hits as the LIKE path", async () => {
    resetSearchCapabilityCache();
    const queries = ["love", "100%", "_under", "curly", "LOVE YOU"];
    const likeResults = await Promise.all(queries.map((q) => dispatchRoute(db, "GET", `/api/conversations/c2/messages/search?q=${encodeURIComponent(q)}&limit=100`)));
    for (const s of FTS_MIGRATION_STATEMENTS) raw.exec(s);
    raw.exec(FTS_BACKFILL_SQL);
    resetSearchCapabilityCache();
    const ftsResults = await Promise.all(queries.map((q) => dispatchRoute(db, "GET", `/api/conversations/c2/messages/search?q=${encodeURIComponent(q)}&limit=100`)));
    expect(ftsResults).toEqual(likeResults);
    expect((likeResults[0] as any).items.length).toBeGreaterThan(0);
    raw.exec("DROP TABLE messages_fts; DROP TRIGGER messages_fts_ai; DROP TRIGGER messages_fts_ad; DROP TRIGGER messages_fts_au;");
    resetSearchCapabilityCache();
  });
});

describe("merged conversations and participants", () => {
  it("serves an aliased conversation as its canonical one", async () => {
    const fresh = buildDb();
    const mdb = nodeDb(fresh);
    fresh.prepare("INSERT INTO conversation_alias VALUES ('c3', 'c1')").run();
    fresh.prepare("INSERT INTO participant_alias VALUES ('+15552220004', '+15552220001')").run();

    const list: any = await dispatchRoute(mdb, "GET", "/api/conversations?page_size=100");
    expect(list.items.map((i: any) => i.id)).not.toContain("c3");
    const c1 = list.items.find((i: any) => i.id === "c1");
    expect(c1.message_count).toBe(260 + 60);

    const viaAlias: any = await dispatchRoute(mdb, "GET", "/api/conversations/c3");
    expect(viaAlias.id).toBe("c1");
    expect(viaAlias.message_count).toBe(320);
    expect(viaAlias.participants.map((p: any) => p.id)).toEqual(["+15552220001", "me"]);

    const page: any = await dispatchRoute(mdb, "GET", "/api/conversations/c1/messages?limit=500");
    expect(page.items.length).toBe(320);
    const ts = page.items.map((i: any) => i.timestamp);
    expect([...ts].sort()).toEqual(ts);
    expect(page.items.every((m: any) => m.sender_id !== "+15552220004")).toBe(true);

    const stats: any = await dispatchRoute(mdb, "GET", "/api/conversations/c1/participant-stats");
    expect(stats.participants.reduce((a: number, p: any) => a + p.message_count, 0)).toBe(320);
  });
});
