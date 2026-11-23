import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { migrate, SCHEMA_VERSION, type SqlRunner } from "./schema";
import { hasRoomFor } from "./storage/quota";

function runner(db: Database.Database): SqlRunner {
  return {
    exec: (s) => { db.exec(s); },
    getUserVersion: () => db.pragma("user_version", { simple: true }) as number,
    setUserVersion: (v) => { db.pragma(`user_version = ${v}`); },
  };
}

describe("schema", () => {
  it("migrates a fresh DB and is idempotent", async () => {
    const db = new Database(":memory:");
    expect(await migrate(runner(db))).toBe(SCHEMA_VERSION);
    expect(await migrate(runner(db))).toBe(SCHEMA_VERSION);
    const names = (db.prepare("SELECT name FROM sqlite_master").all() as { name: string }[]).map((r) => r.name);
    for (const t of ["participants", "conversations", "conversation_participants", "messages", "tapbacks",
      "announcements", "contacts", "sync_state", "participant_alias", "conversation_alias",
      "summary_conversation", "summary_overview_conv", "summary_overview_daily", "summary_overview_dow_hour",
      "summary_reply_delta", "merge_history", "conversation_merge_history",
      "v_participants", "v_conversations", "v_conversation_participants", "v_messages", "v_tapbacks", "v_announcements",
      "idx_messages_conversation", "idx_messages_sender", "idx_messages_reply_to",
      "idx_messages_convo_ts_id", "idx_tapbacks_message", "idx_announcements_conversation"]) {
      expect(names).toContain(t);
    }
  });

  it("rejects a DB newer than the app", async () => {
    const db = new Database(":memory:");
    db.pragma(`user_version = ${SCHEMA_VERSION + 1}`);
    await expect(migrate(runner(db))).rejects.toThrow(/newer/);
  });

  it("enforces guid uniqueness, cascades, and resolves aliases via views", async () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    await migrate(runner(db));
    db.exec(`
      INSERT INTO participants(id,is_me) VALUES('me',1),('+15551234567',0),('+15557654321',0);
      INSERT INTO conversations(id,is_group_chat,relationship_type,chat_guid,chat_rowid) VALUES('c1',0,'friend','c1',1);
      INSERT INTO messages(id,conversation_id,sender_id,timestamp,text,guid,rowid_src,is_from_me)
        VALUES('m1','c1','me','2024-01-01T00:00:00.000Z','hi','g1',1,1);
      INSERT INTO tapbacks(message_id,reactor_id,action) VALUES('m1','+15551234567','loved');
      INSERT INTO participant_alias VALUES('+15557654321','+15551234567');
    `);
    expect(() => db.exec(`INSERT INTO messages(id,conversation_id,sender_id,timestamp,text,guid)
      VALUES('m2','c1','me','t','x','g1')`)).toThrow(/UNIQUE/);
    expect(db.prepare("SELECT id FROM v_participants ORDER BY id").all()).toEqual([{ id: "+15551234567" }, { id: "me" }]);
    db.exec("INSERT INTO messages(id,conversation_id,sender_id,timestamp,text,guid) VALUES('m3','c1','+15557654321','t','y','g3')");
    expect(db.prepare("SELECT sender_id FROM v_messages WHERE id='m3'").get()).toEqual({ sender_id: "+15551234567" });
    db.exec("DELETE FROM conversations WHERE id='c1'");
    expect(db.prepare("SELECT count(*) n FROM messages").get()).toEqual({ n: 0 });
    // tapbacks have no FK to messages (a reaction can arrive before its target), so deleting
    // messages is done explicitly by the ingest writer (see AppWriter.deleteMessages)
    expect(db.prepare("SELECT count(*) n FROM tapbacks").get()).toEqual({ n: 1 });
    expect(() => db.exec("INSERT INTO tapbacks(message_id,reactor_id,action) VALUES('not-yet-ingested','me','liked')")).not.toThrow();
  });

  it("uses the conversation/timestamp index for paging", async () => {
    const db = new Database(":memory:");
    await migrate(runner(db));
    const plan = db.prepare("EXPLAIN QUERY PLAN SELECT id FROM messages WHERE conversation_id=? ORDER BY timestamp,id LIMIT 10").all("c") as { detail: string }[];
    expect(plan.map((p) => p.detail).join(" ")).toContain("idx_messages_convo_ts_id");
  });
});

describe("quota", () => {
  it("hasRoomFor", () => {
    expect(hasRoomFor(null, 1e12)).toBe(true);
    expect(hasRoomFor({ usageMB: 0, quotaMB: 100, availableMB: 100 }, 80 * 1048576)).toBe(false);
    expect(hasRoomFor({ usageMB: 0, quotaMB: 100, availableMB: 100 }, 50 * 1048576)).toBe(true);
  });
});
