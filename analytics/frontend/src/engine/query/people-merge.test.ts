import { beforeEach, describe, expect, it } from "vitest";
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import type { SqlDb } from "./shim";
import {
  applyMergeMigration, mergeConversations, mergeParticipants, MergeError, listParticipants,
  listConversationsForMerge, listMergeHistory, listConversationMergeHistory,
} from "./merge";
import { listPeople, getPersonDetail } from "./people";
import { buildConversationDisplayName } from "./names";

const SCHEMA = `
CREATE TABLE participants (id TEXT PRIMARY KEY, handle TEXT, display_name TEXT, is_me INTEGER NOT NULL DEFAULT 0);
CREATE TABLE conversations (id TEXT PRIMARY KEY, chat_guid TEXT, is_group_chat INTEGER NOT NULL, relationship_type TEXT NOT NULL, convo_name TEXT);
CREATE TABLE conversation_participants (conversation_id TEXT NOT NULL, participant_id TEXT NOT NULL, PRIMARY KEY (conversation_id, participant_id));
CREATE TABLE messages (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, sender_id TEXT NOT NULL, timestamp TEXT NOT NULL,
  text TEXT NOT NULL, has_attachment INTEGER DEFAULT 0, has_sticker INTEGER DEFAULT 0, reply_to TEXT,
  rowid_src INTEGER, guid TEXT, date_edited TEXT, date_retracted TEXT, service TEXT, is_from_me INTEGER);
CREATE INDEX idx_messages_sender ON messages(sender_id);
CREATE INDEX idx_messages_conversation ON messages(conversation_id);
CREATE TABLE tapbacks (id INTEGER PRIMARY KEY AUTOINCREMENT, message_id TEXT NOT NULL, reactor_id TEXT NOT NULL, action TEXT NOT NULL, UNIQUE(message_id, reactor_id, action));
CREATE TABLE announcements (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, datetime TEXT NOT NULL, announcer_id TEXT NOT NULL, action TEXT NOT NULL, affected_id TEXT);
CREATE TABLE contacts (handle TEXT PRIMARY KEY, display_name TEXT);
`;

let db: SqlDb;
let n = 0;

async function makeDb(): Promise<SqlDb> {
  const sqlite3 = await sqlite3InitModule();
  const raw = new sqlite3.oo1.DB(":memory:");
  return {
    all: async (sql, params = []) => raw.exec({ sql, bind: params as any, rowMode: "object", returnValue: "resultRows" }) as any,
    run: async (sql, params = []) => { raw.exec({ sql, bind: params as any }); return raw.changes(); },
    exec: async (sql) => { raw.exec(sql); },
  };
}

async function msg(conv: string, sender: string, ts: string, text = "hi") {
  await db.run(`INSERT INTO messages (id, conversation_id, sender_id, timestamp, text) VALUES (?,?,?,?,?)`,
    [`m${++n}`, conv, sender, ts, text]);
}

beforeEach(async () => {
  n = 0;
  db = await makeDb();
  (await db.exec(SCHEMA));
  (await applyMergeMigration(db));
  (await db.exec(`
    INSERT INTO participants (id, handle, is_me) VALUES ('me','',1),('+15551110001','+15551110001',0),
      ('alice@x.com','alice@x.com',0),('+15551110003','+15551110003',0);
    INSERT INTO contacts VALUES ('+15551110001','Alice Phone'),('+15551110003','Carl');
    INSERT INTO conversations VALUES ('c1','c1',0,'friend',NULL),('c2','c2',0,'friend',NULL),('g1','g1',1,'friend','Trip');
    INSERT INTO conversation_participants VALUES ('c1','me'),('c1','+15551110001'),('c2','me'),('c2','alice@x.com'),
      ('g1','me'),('g1','+15551110001'),('g1','alice@x.com'),('g1','+15551110003');
  `));
  (await msg("c1", "+15551110001", "2024-01-01T10:00:00.000Z"));
  (await msg("c1", "me", "2024-01-01T10:01:00.000Z"));
  (await msg("c2", "alice@x.com", "2024-02-01T23:00:00.000Z"));
  (await msg("c2", "alice@x.com", "2024-02-02T23:00:00.000Z"));
  (await msg("g1", "+15551110003", "2024-03-01T12:00:00.000Z"));
  (await msg("g1", "alice@x.com", "2024-03-02T12:00:00.000Z"));
});

describe("names", () => {
  it("resolves names from contacts table", async () => {
    const names = Object.fromEntries((await listParticipants(db)).map((p) => [p.id, p.display_name]));
    expect(names).toMatchObject({ me: "You", "+15551110001": "Alice Phone", "alice@x.com": "alice@x.com", "+15551110003": "Carl" });
  });
  it("conversation display name", async () => {
    const p = (n: string, me = false) => ({ id: n, handle: n, display_name: n, is_me: me });
    expect(buildConversationDisplayName([p("me", true)])).toBe("You");
    expect(buildConversationDisplayName([p("a"), p("b"), p("c"), p("d")])).toBe("a, b +2 more");
    expect(buildConversationDisplayName([p("a")], "Trip")).toBe("Trip");
  });
  it("participant response shape", async () => {
    const a = (await listParticipants(db)).find((p) => p.id === "alice@x.com")!;
    expect(a).toEqual({ id: "alice@x.com", phone_num: null, email: "alice@x.com", handle: "alice@x.com", display_name: "alice@x.com", is_me: false });
  });
});

describe("people list", () => {
  it("sorts and paginates in SQL", async () => {
    const byCount = (await listPeople(db, { sort: "count", order: "desc" }));
    expect(byCount.total).toBe(4);
    expect(byCount.items[0]).toMatchObject({ id: "alice@x.com", message_count: 3, conversation_count: 2 });
    expect((await listPeople(db, { sort: "count", order: "asc", page: 1, page_size: 2 })).items.length).toBe(2);
    const recent = (await listPeople(db, { sort: "recent", order: "desc" })).items;
    expect(recent[0].id).toBe("alice@x.com");
    expect(recent[0].last_message_at).toBe("2024-03-02T12:00:00.000Z");
    expect((await listPeople(db, { sort: "conversations", order: "desc" })).items[0].conversation_count).toBe(3);
    expect((await listPeople(db, { sort: "conversations", order: "asc" })).items[0].conversation_count).toBe(1);
  });
  it("searches display name case-insensitively", async () => {
    const r = (await listPeople(db, { search: "ALICE" }));
    expect(r.items.map((i) => i.id)).toEqual(["alice@x.com", "+15551110001"]);
    expect(r.total).toBe(2);
    expect((await listPeople(db, { search: "100%" })).total).toBe(0);
    expect((await listPeople(db, { page: 2, page_size: 3 })).items.length).toBe(1);
  });
});

describe("participant merge", () => {
  it("rolls up counts and hides removed id", async () => {
    (await mergeParticipants(db, "+15551110001", "alice@x.com"));
    const people = (await listPeople(db, { sort: "count", order: "desc" }));
    expect(people.total).toBe(3);
    expect(people.items[0]).toMatchObject({ id: "+15551110001", display_name: "Alice Phone", message_count: 4, conversation_count: 3 });
    const d = (await getPersonDetail(db, "+15551110001"))!;
    expect(d.message_count).toBe(4);
    expect(d.conversations).toHaveLength(3);
    expect((await getPersonDetail(db, "alice@x.com"))).toBeNull();
    expect(Object.keys(d.leaderboard as object)).toHaveLength(15);
    expect(d.heatmap.grid).toHaveLength(7);
    const h = (await listMergeHistory(db)) as any[];
    expect(h[0]).toMatchObject({ keep_message_count: 1, remove_message_count: 3, remove_handle: "alice@x.com" });
  });
  it("survives later ingest of rows for the removed id", async () => {
    (await mergeParticipants(db, "+15551110001", "alice@x.com"));
    (await msg("c2", "alice@x.com", "2024-05-01T00:00:00.000Z"));
    (await db.run(`INSERT OR IGNORE INTO participants (id, handle, is_me) VALUES ('alice@x.com','alice@x.com',0)`));
    expect((await listPeople(db, {})).items.find((i) => i.id === "+15551110001")!.message_count).toBe(5);
    expect((await listPeople(db, {})).total).toBe(3);
    expect((await db.all(`SELECT COUNT(*) AS c FROM v_messages WHERE sender_id='+15551110001'`))[0]).toEqual({ c: 5 });
  });
  it("flattens chains", async () => {
    (await mergeParticipants(db, "alice@x.com", "+15551110003"));
    (await mergeParticipants(db, "+15551110001", "alice@x.com"));
    const rows = (await db.all<{ from_id: string; to_id: string }>(`SELECT * FROM participant_alias ORDER BY from_id`));
    expect(rows.every((r) => r.to_id === "+15551110001")).toBe(true);
    expect(rows).toHaveLength(2);
    expect((await listPeople(db, {})).items.find((i) => i.id === "+15551110001")!.message_count).toBe(5);
  });
  it("validates", async () => {
    await expect(mergeParticipants(db, "me", "me")).rejects.toThrow(MergeError);
    await expect(mergeParticipants(db, "alice@x.com", "nope")).rejects.toThrow(MergeError);
    (await mergeParticipants(db, "+15551110001", "alice@x.com"));
    await expect(mergeParticipants(db, "+15551110001", "alice@x.com")).rejects.toThrow(MergeError);
  });
  it("dedupes tapbacks/conversation_participants in views", async () => {
    (await db.run(`INSERT INTO tapbacks (message_id, reactor_id, action) VALUES ('m1','alice@x.com','love'),('m1','+15551110001','love')`));
    (await mergeParticipants(db, "+15551110001", "alice@x.com"));
    expect((await db.all(`SELECT * FROM v_tapbacks`))).toHaveLength(1);
    expect((await db.all(`SELECT * FROM v_conversation_participants WHERE conversation_id='g1'`))).toHaveLength(3);
  });
});

describe("conversation merge", () => {
  it("merges and keeps merging after more data", async () => {
    (await mergeConversations(db, "c1", "c2"));
    let list = (await listConversationsForMerge(db));
    expect(list.map((c) => c.id).sort()).toEqual(["c1", "g1"]);
    const c1 = list.find((c) => c.id === "c1")!;
    expect(c1).toMatchObject({ message_count: 4, is_group_chat: false });
    expect(c1.subtext).toBe("+15551110001, alice@x.com");
    (await msg("c2", "me", "2024-06-01T00:00:00.000Z"));
    list = (await listConversationsForMerge(db));
    expect(list.find((c) => c.id === "c1")!.message_count).toBe(5);
    const h = (await listConversationMergeHistory(db)) as any[];
    expect(h[0]).toMatchObject({ keep_id: "c1", remove_id: "c2", keep_message_count: 2, remove_message_count: 2 });
    expect((await db.all(`SELECT COUNT(*) c FROM v_messages WHERE conversation_id='c1'`))[0]).toEqual({ c: 5 });
    await expect(mergeConversations(db, "c1", "c2")).rejects.toThrow(MergeError);
    await expect(mergeConversations(db, "c1", "c1")).rejects.toThrow(MergeError);
  });
  it("person detail counts merged conversation once", async () => {
    (await mergeConversations(db, "c1", "c2"));
    const d = (await getPersonDetail(db, "me"))!;
    expect(d.conversation_count).toBe(2);
    expect((d.conversations as any[])[0]).toMatchObject({ conversation_id: "c1", message_count: 4 });
  });
});
