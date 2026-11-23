import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  bucketVolume,
  getParticipantStats,
  getPersonalityLeaderboard,
  getPersonStats,
  longestStreakDays,
  personalityRates,
  refreshStatsSummary,
  round1,
  topWords,
  type StatsDb,
} from "./stats";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite");
const fixtureDir = new URL("./__fixtures__/", import.meta.url).pathname;
const golden = JSON.parse(readFileSync(fixtureDir + "stats-golden.json", "utf8"));

function openDb(): StatsDb {
  // copy into memory so the cache tables don't mutate the fixture file
  const src = new DatabaseSync(fixtureDir + "stats-fixture.db", { readOnly: true });
  const mem = new DatabaseSync(":memory:");
  const ddl = src.prepare("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'").all();
  for (const r of ddl) mem.exec(r.sql);
  for (const t of ["participants", "conversation_participants", "messages", "tapbacks"]) {
    const rows = src.prepare(`SELECT * FROM ${t}`).all();
    for (const r of rows) {
      const cols = Object.keys(r);
      mem.prepare(`INSERT INTO ${t} (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`).run(...Object.values(r));
    }
  }
  return {
    all: (sql, params = []) => mem.prepare(sql).all(...params),
    run: (sql, params = []) => void mem.prepare(sql).run(...params),
  };
}

const FLOAT_TOL = 1e-6;
const SENT_TOL = 1e-4; // vader.ts is an exact port; allow only float noise

function expectClose(a: any, b: any, path: string, tol = FLOAT_TOL) {
  if (typeof a === "number" && typeof b === "number") {
    expect(Math.abs(a - b), `${path}: ${a} vs ${b}`).toBeLessThanOrEqual(tol);
  } else if (Array.isArray(a)) {
    expect(a.length, path).toBe(b.length);
    a.forEach((x, i) => expectClose(x, b[i], `${path}[${i}]`, tol));
  } else if (a && typeof a === "object") {
    expect(Object.keys(a).sort(), path).toEqual(Object.keys(b).sort());
    for (const k of Object.keys(a)) expectClose(a[k], b[k], `${path}.${k}`, k === "score" ? SENT_TOL : tol);
  } else expect(a, path).toEqual(b);
}

/** Tie order inside count lists is implementation-defined in Python's unordered SQL; compare as maps. */
function normalizeTapbacks(p: any) {
  for (const k of ["tapbacks_given", "tapbacks_received"]) {
    p[k] = p[k].slice().sort((x: any, y: any) => y.count - x.count || x.action.localeCompare(y.action));
  }
  return p;
}

describe("golden: participant-stats", () => {
  for (const cid of Object.keys(golden.participant_stats)) {
    it(cid, async () => {
      const db = openDb();
      const got = await getParticipantStats(db, cid);
      const firstJson = JSON.stringify(got);
      const want = golden.participant_stats[cid];
      for (const side of [got, want]) {
        side.participants.forEach(normalizeTapbacks);
        side.participants.sort((a: any, b: any) => a.participant_id.localeCompare(b.participant_id));
      }
      expectClose(JSON.parse(JSON.stringify(got)), want, cid);
      // second call is served from the cache and must be identical
      expect(JSON.stringify(await getParticipantStats(db, cid))).toEqual(firstJson);
    });
  }
});

describe("golden: personality-leaderboard", () => {
  for (const cid of Object.keys(golden.personality_leaderboard)) {
    it(cid, async () => {
      const got = await getPersonalityLeaderboard(openDb(), cid);
      const want = golden.personality_leaderboard[cid];
      // entries with equal share may order differently; sort both deterministically
      for (const side of [got, want]) for (const t of side.traits) t.entries.sort((a: any, b: any) => b.share - a.share || a.participant_id.localeCompare(b.participant_id));
      expectClose(JSON.parse(JSON.stringify(got)), want, cid);
    });
  }
});

describe("golden: person stats", () => {
  for (const pid of Object.keys(golden.person_stats)) {
    it(pid, async () => {
      const got = await getPersonStats(openDb(), pid);
      const want = golden.person_stats[pid];
      normalizeTapbacks(got);
      normalizeTapbacks(want);
      expectClose(JSON.parse(JSON.stringify(got)), want, pid);
    });
  }
});

describe("refreshStatsSummary", () => {
  it("recomputes only the changed conversation", async () => {
    const db = openDb();
    await getParticipantStats(db, "c1");
    await getParticipantStats(db, "c2");
    db.run("INSERT INTO messages VALUES ('c1-new','c1','me','2030-01-01T00:00:00.000','hello there friend')");
    const before = (await getParticipantStats(db, "c1")).participants.find((p) => p.participant_id === "me")!.message_count;
    await refreshStatsSummary(db, ["c1"]);
    const after = (await getParticipantStats(db, "c1")).participants.find((p) => p.participant_id === "me")!.message_count;
    expect(after).toBe(before + 1);
    const c2 = db.all("SELECT data FROM summary_conversation_stats WHERE conversation_id='c2'") as any[];
    expect(c2.length).toBe(1);
  });
  it("applies participant aliases at read time", async () => {
    const db = openDb();
    db.run("CREATE TABLE participant_alias (from_id TEXT PRIMARY KEY, to_id TEXT)");
    db.run("INSERT INTO participant_alias VALUES ('+15551230002','+15551230001')");
    const r = await getParticipantStats(db, "c2");
    expect(r.participants.map((p) => p.participant_id)).not.toContain("+15551230002");
    expect(r.participants.reduce((s, p) => s + p.message_count, 0)).toBe(400);
  });
});

describe("pure helpers", () => {
  it("round1 matches Python half-even", () => {
    expect(round1(0.25)).toBe(0.2);
    expect(round1(0.75)).toBe(0.8);
    expect(round1(12.34)).toBe(12.3);
  });
  it("bucketVolume fills gaps and uses Monday weeks", () => {
    expect(bucketVolume([["2024-01-01", 2], ["2024-01-10", 3]], "week")).toEqual([["2024-01-01", 2], ["2024-01-08", 3]]);
    expect(bucketVolume([["2024-01-30", 1], ["2024-02-02", 1]], "month")).toEqual([["2024-01", 1], ["2024-02", 1]]);
  });
  it("streak, words, personality", () => {
    expect(longestStreakDays([{ day: "2024-01-01", startTs: "", endTs: "" }, { day: "2024-01-02", startTs: "", endTs: "" }])).toBe(2);
    expect(topWords(["Don’t stop believing believing"])).toEqual([["believing", 2], ["stop", 1]]);
    expect(personalityRates(Array(20).fill("I love this!!")).find((t) => t[0] === "Wholesome")![1]).toBe(100);
  });
});
