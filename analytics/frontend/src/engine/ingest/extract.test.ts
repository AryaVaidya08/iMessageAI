import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import {
  ChatDbExtractor,
  appleMsToIso,
  classifyTapback,
  targetGuid,
  type ChatDbReader,
  type ExtractedBatch,
} from "./extract";
import { decodeAttributedBody } from "./typedstream";
import { normalizeHandle } from "../handles";

function attributed(text: string): Buffer {
  const body = Buffer.from(text, "utf8");
  const len =
    body.length < 0x80
      ? Buffer.from([body.length])
      : Buffer.from([0x81, body.length & 0xff, (body.length >> 8) & 0xff]);
  return Buffer.concat([
    Buffer.from("\x04\x0bstreamtyped\x81\xe8\x03\x84\x01@\x84\x84\x84\x12NSAttributedString\x00\x84\x84\x08NSObject\x00\x85\x92\x84\x84\x84\x08NSString\x01\x94\x84\x01+", "latin1"),
    len,
    body,
    Buffer.from("\x86\x84\x02iI\x01", "latin1"),
  ]);
}

const NS = 1_000_000;
const ns = (isoSecondsAfter2001: number) => isoSecondsAfter2001 * 1e9;

function fixture() {
  const db = new Database(":memory:");
  db.exec(`
  CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT, service TEXT);
  CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, guid TEXT, style INTEGER, display_name TEXT);
  CREATE TABLE message (ROWID INTEGER PRIMARY KEY, guid TEXT, text TEXT, attributedBody BLOB, handle_id INTEGER DEFAULT 0,
    service TEXT, date INTEGER, date_edited INTEGER DEFAULT 0, date_retracted INTEGER DEFAULT 0, is_from_me INTEGER DEFAULT 0,
    cache_has_attachments INTEGER DEFAULT 0, associated_message_guid TEXT, associated_message_type INTEGER DEFAULT 0,
    associated_message_emoji TEXT, thread_originator_guid TEXT, reply_to_guid TEXT, item_type INTEGER DEFAULT 0,
    group_action_type INTEGER DEFAULT 0, group_title TEXT, other_handle INTEGER DEFAULT 0);
  CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER, message_date INTEGER, PRIMARY KEY (chat_id, message_id));
  CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER);
  CREATE TABLE attachment (ROWID INTEGER PRIMARY KEY, is_sticker INTEGER DEFAULT 0, mime_type TEXT);
  CREATE TABLE message_attachment_join (message_id INTEGER, attachment_id INTEGER);
  INSERT INTO handle VALUES (1,'+14155550001','iMessage'),(2,'(415) 555-0002','SMS'),(3,'Bob@Example.com','iMessage'),(4,'+442071838750','iMessage');
  INSERT INTO chat VALUES (1,'iMessage;-;+14155550001',45,NULL),(2,'iMessage;+;chat123',43,'Road Trip'),(3,'iMessage;-;+442071838750',45,NULL);
  INSERT INTO chat_handle_join VALUES (1,1),(2,1),(2,2),(2,3),(3,4);
  `);
  const ins = db.prepare(
    `INSERT INTO message (ROWID,guid,text,attributedBody,handle_id,service,date,date_edited,date_retracted,is_from_me,cache_has_attachments,associated_message_guid,associated_message_type,associated_message_emoji,thread_originator_guid,reply_to_guid,item_type,group_action_type,group_title,other_handle)
     VALUES (@r,@g,@t,@ab,@h,'iMessage',@d,@de,@dr,@me,@att,@ag,@at,@ae,@tog,@rtg,@it,@gat,@gt,@oh)`
  );
  const base = { t: null, ab: null, h: 0, d: 0, de: 0, dr: 0, me: 0, att: 0, ag: null, at: 0, ae: null, tog: null, rtg: null, it: 0, gat: 0, gt: null, oh: 0 };
  const msg = (o: Record<string, unknown>) => ins.run({ ...base, ...o });
  const join = db.prepare("INSERT INTO chat_message_join VALUES (?,?,?)");
  const add = (chat: number, o: Record<string, unknown>) => {
    msg(o);
    join.run(chat, o.r, o.d ?? 0);
  };
  add(1, { r: 1, g: "G1", t: "hello", h: 1, d: ns(700_000_000) });
  add(1, { r: 2, g: "G2", t: "hi back", me: 1, d: ns(700_000_100) + 123 * NS });
  add(1, { r: 3, g: "G3", ab: attributed("from attributedBody \u{1F600}"), h: 1, d: ns(700_000_200) });
  add(1, { r: 4, g: "G4", t: "reply", me: 1, d: ns(700_000_300), tog: "G1", rtg: "G3" });
  add(1, { r: 5, g: "G5", at: 2000, ag: "p:0/G1", h: 1, d: ns(700_000_400) });
  add(1, { r: 6, g: "G6", at: 3000, ag: "p:0/G1", h: 1, d: ns(700_000_500) });
  add(1, { r: 7, g: "G7", t: "￼", h: 1, att: 1, d: ns(700_000_600) });
  db.exec("INSERT INTO attachment VALUES (1,0,'image/jpeg'),(2,1,'image/png'); INSERT INTO message_attachment_join VALUES (7,1),(8,2);");
  add(1, { r: 8, g: "G8", t: "￼", h: 1, att: 1, d: ns(700_000_700) }); // sticker
  add(1, { r: 9, g: "G9", t: "edited text", me: 1, d: ns(700_000_800), de: ns(700_000_900) });
  add(1, { r: 10, g: "G10", t: null, me: 1, d: ns(700_001_000), dr: ns(700_001_100) }); // unsent
  add(1, { r: 11, g: "G11", t: "", h: 1, d: ns(700_001_200) }); // empty: skipped
  add(1, { r: 12, g: "G12", at: 2006, ae: "\u{1F525}", ag: "bp:G9", h: 1, d: ns(700_001_300) });
  // group chat
  add(2, { r: 20, g: "G20", t: "group hi", h: 2, d: ns(700_002_000) });
  add(2, { r: 21, g: "G21", it: 2, gt: "Road Trip", me: 1, d: ns(700_002_100) });
  add(2, { r: 22, g: "G22", it: 1, gat: 0, me: 1, oh: 3, d: ns(700_002_200) });
  add(2, { r: 23, g: "G23", it: 1, gat: 1, h: 1, oh: 2, d: ns(700_002_300) });
  add(2, { r: 24, g: "G24", it: 3, gat: 0, h: 3, d: ns(700_002_400) });
  add(2, { r: 25, g: "G25", t: "from bob", h: 3, d: ns(700_002_500) });
  // intl chat
  add(3, { r: 30, g: "G30", t: "cheers", h: 4, d: ns(700_003_000) });
  return db;
}

function reader(db: Database.Database): ChatDbReader {
  return { query: (sql, params = []) => db.prepare(sql).all(...(params as any[])) as any };
}

async function collect(gen: AsyncGenerator<ExtractedBatch>) {
  const out: ExtractedBatch[] = [];
  for await (const b of gen) out.push(b);
  return out;
}

describe("typedstream", () => {
  it("decodes short and long strings", () => {
    expect(decodeAttributedBody(attributed("hi é"))).toBe("hi é");
    const long = "x".repeat(500);
    expect(decodeAttributedBody(attributed(long))).toBe(long);
    expect(decodeAttributedBody(Buffer.from("garbage"))).toBeNull();
  });
});

describe("helpers", () => {
  it("dates", () => {
    expect(appleMsToIso(0)).toBe("2001-01-01T00:00:00.000Z");
  });
  it("tapbacks", () => {
    expect(classifyTapback(2001)).toEqual({ action: "Liked", removed: false });
    expect(classifyTapback(3003)).toEqual({ action: "Laughed", removed: true });
    expect(classifyTapback(2006, "x")?.action).toBe("x");
    expect(classifyTapback(0)).toBeNull();
    expect(targetGuid("p:1/ABC")).toBe("ABC");
    expect(targetGuid("bp:ABC")).toBe("ABC");
  });
  it("handles", () => {
    expect(normalizeHandle("(415) 555-0002")).toBe("+14155550002");
    expect(normalizeHandle("+44 20 7183 8750")).toBe("+442071838750");
    expect(normalizeHandle("Bob@Example.com")).toBe("bob@example.com");
  });
});

describe("ChatDbExtractor", () => {
  it("lists chats with counts", async () => {
    const x = new ChatDbExtractor(reader(fixture()));
    const chats = await x.listChats();
    expect(chats.map((c) => [c.guid, c.messageCount])).toEqual([
      ["iMessage;-;+14155550001", 12],
      ["iMessage;+;chat123", 6],
      ["iMessage;-;+442071838750", 1],
    ]);
    expect(await x.countMessages()).toBe(19);
    expect(await x.countMessages(20)).toBe(6);
  });

  it("extracts messages, tapbacks, announcements for 1:1 chat", async () => {
    const x = new ChatDbExtractor(reader(fixture()));
    const [chat] = await x.listChats();
    const batches = await collect(x.extractChat(chat));
    expect(batches).toHaveLength(1);
    const b = batches[0];
    expect(b.conversation).toMatchObject({ id: "iMessage;-;+14155550001", is_group_chat: 0, convo_name: null });
    expect(b.scanned).toBe(12);
    const m = Object.fromEntries(b.messages.map((r) => [r.guid, r]));
    expect(Object.keys(m).sort()).toEqual(["G1", "G2", "G3", "G4", "G7", "G8", "G9"].sort());
    expect(m.G1.sender_id).toBe("+14155550001");
    expect(m.G2.sender_id).toBe("me");
    expect(m.G2.is_from_me).toBe(1);
    expect(m.G2.timestamp).toBe("2023-03-08T08:51:40.123Z".replace("2023-03-08T08:51:40.123Z", appleMsToIso(700_000_100_123)!));
    expect(m.G3.text).toBe("from attributedBody \u{1F600}");
    expect(m.G4.reply_to).toBe("G1");
    expect(m.G7).toMatchObject({ text: "", has_attachment: 1, has_sticker: 0 });
    expect(m.G8).toMatchObject({ has_attachment: 0, has_sticker: 1 });
    expect(m.G9.date_edited).toBe(appleMsToIso(700_000_900_000));
    expect(b.retractedGuids).toEqual(["G10"]);
    expect(b.announcements.map((a) => [a.action, a.announcer_id])).toEqual([["unsent message", "me"]]);
    expect(b.tapbacks.map((t) => [t.message_id, t.action, t.removed, t.reactor_id])).toEqual([
      ["G1", "Loved", false, "+14155550001"],
      ["G1", "Loved", true, "+14155550001"],
      ["G9", "\u{1F525}", false, "+14155550001"],
    ]);
    expect(b.participants.map((p) => p.id).sort()).toEqual(["+14155550001", "me"]);
  });

  it("extracts group chat announcements and names", async () => {
    const x = new ChatDbExtractor(reader(fixture()));
    const chats = await x.listChats();
    const [b] = await collect(x.extractChat(chats[1]));
    expect(b.conversation).toMatchObject({ is_group_chat: 1, convo_name: "Road Trip" });
    expect(b.conversationParticipantIds.sort()).toEqual(["+14155550001", "+14155550002", "bob@example.com", "me"]);
    expect(b.announcements.map((a) => [a.action, a.announcer_id, a.affected_id])).toEqual([
      ["renamed convo", "me", null],
      ["added person", "me", "bob@example.com"],
      ["removed person", "+14155550001", "+14155550002"],
      ["left convo", "bob@example.com", null],
    ]);
    expect(b.announcements[0].title).toBe("Road Trip");
    expect(b.messages.map((m) => m.sender_id)).toEqual(["+14155550002", "bob@example.com"]);
    expect(b.participants.find((p) => p.id === "bob@example.com")?.email).toBe("bob@example.com");
  });

  it("paginates in batches and dedupes participant emission", async () => {
    const x = new ChatDbExtractor(reader(fixture()));
    const [chat] = await x.listChats();
    const batches = await collect(x.extractChat(chat, { batchSize: 5 }));
    expect(batches.map((b) => b.scanned)).toEqual([5, 5, 2]);
    expect(batches.flatMap((b) => b.participants).map((p) => p.id).sort()).toEqual(["+14155550001", "me"]);
    expect(batches.at(-1)!.lastRowid).toBe(12);
  });

  it("sinceRowid yields only newer messages and skips idle chats", async () => {
    const x = new ChatDbExtractor(reader(fixture()));
    const batches = await collect(x.extractAll({ sinceRowid: 24 }));
    expect(batches.map((b) => b.conversation.chat_rowid)).toEqual([2, 3]);
    expect(batches.flatMap((b) => b.messages.map((m) => m.guid))).toEqual(["G25", "G30"]);
    expect(batches[0].announcements.map((a) => a.guid)).toEqual([]);
  });

  it("enumerates edited/unsent and re-extracts by rowid", async () => {
    const x = new ChatDbExtractor(reader(fixture()));
    const ch = await x.listEditedOrRetracted();
    expect(ch.map((c) => [c.guid, !!c.dateEdited, !!c.dateRetracted])).toEqual([
      ["G9", true, false],
      ["G10", false, true],
    ]);
    expect(await x.listEditedOrRetracted(9)).toHaveLength(1);
    const batches = await collect(x.extractRowids(ch.map((c) => c.rowid)));
    expect(batches).toHaveLength(1);
    expect(batches[0].messages.map((m) => m.guid)).toEqual(["G9"]);
    expect(batches[0].retractedGuids).toEqual(["G10"]);
  });

  it("works on an older schema lacking newer columns", async () => {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
      CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, guid TEXT, style INTEGER, display_name TEXT);
      CREATE TABLE message (ROWID INTEGER PRIMARY KEY, guid TEXT, text TEXT, handle_id INTEGER, date INTEGER, is_from_me INTEGER);
      CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER, PRIMARY KEY (chat_id, message_id));
      CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER);
      CREATE TABLE attachment (ROWID INTEGER PRIMARY KEY, is_sticker INTEGER);
      CREATE TABLE message_attachment_join (message_id INTEGER, attachment_id INTEGER);
      INSERT INTO handle VALUES (1,'+14155550001'); INSERT INTO chat VALUES (1,'c1',45,''); INSERT INTO chat_handle_join VALUES (1,1);
      INSERT INTO message VALUES (1,'A','old',1,500000000,0); INSERT INTO chat_message_join VALUES (1,1);
    `);
    const x = new ChatDbExtractor(reader(db));
    const batches = await collect(x.extractAll());
    expect(batches[0].messages[0]).toMatchObject({ text: "old", timestamp: appleMsToIso(500_000_000_000 / 1000 * 1000 / 1000 * 1000) });
    expect(await x.listEditedOrRetracted()).toEqual([]);
  });
});
